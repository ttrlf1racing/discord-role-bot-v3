require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionFlagsBits
} = require("discord.js");
const { MessageFlags } = require("discord-api-types/v10");
const kv = require("./kvRedis");

const recentlyConfirmed = new Map(); // guildId → Set(userIds)

/**
 * Batching + sequential runner + confirmation gating
 * - pendingBatches: collects flows for a user within 500ms.
 * - runners: single runner per user.
 * - sentGuard: dedupe (guild:user:role) for 30s.
 * - confirmResolvers: Map of (guild:user:flow) → resolver(), unblocks queue only on button click.
 */
const pendingBatches = new Map(); // key → { flows: Array<[flowName, flow]>, timer: Timeout|null }
const runners = new Map();        // key → Promise<void>
const sentGuard = new Map();      // key (g:u:r) → expiresAt (ms)
const confirmResolvers = new Map(); // key (g:u:flowName) → resolver function

const sleep = ms => new Promise(res => setTimeout(res, ms));

// ⏱️ how long to wait for confirmation before giving up (0 = wait forever)
const CONFIRM_TIMEOUT_MS = 0; // e.g. set to 24 * 60 * 60 * 1000 to give up after 24h

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ----------------------
// Shared Slash Commands Template
// ----------------------
const getCommands = () => [
  new SlashCommandBuilder()
    .setName("create-role-message")
    .setDescription("Create a named onboarding flow for a role.")
    .addStringOption(o =>
      o.setName("name").setDescription("Flow name").setRequired(true)
    )
    .addRoleOption(o =>
      o.setName("role").setDescription("Role to assign").setRequired(true)
    )
    .addChannelOption(o =>
      o
        .setName("channel")
        .setDescription("Channel to post onboarding message")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addStringOption(o =>
      o
        .setName("message")
        .setDescription("Message (use {user} and {role} placeholders)")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("edit-role-message")
    .setDescription("Edit an existing onboarding flow.")
    .addStringOption(o =>
      o.setName("name").setDescription("Flow name").setRequired(true)
    )
    .addRoleOption(o =>
      o.setName("role").setDescription("New role").setRequired(false)
    )
    .addChannelOption(o =>
      o
        .setName("channel")
        .setDescription("New channel")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .addStringOption(o =>
      o.setName("message").setDescription("New message").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("delete-role-message")
    .setDescription("Delete a flow.")
    .addStringOption(o =>
      o.setName("name").setDescription("Flow name").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("list-role-messages")
    .setDescription("List all configured onboarding flows.")
].map(c => c.toJSON());

// ----------------------
// Register Commands on Startup
// ----------------------
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = getCommands();

  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
        body: commands
      });
      console.log(`✅ Commands registered for ${guild.name}`);
    } catch (err) {
      console.error(`❌ Failed to register commands for ${guild.name}:`, err);
    }
  }
});

// ----------------------
// Auto-register Commands for New Guilds
// ----------------------
client.on(Events.GuildCreate, async guild => {
  console.log(`🆕 Joined new guild: ${guild.name}`);
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = getCommands();

  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), {
      body: commands
    });
    console.log(`✅ Commands registered for new guild: ${guild.name}`);
  } catch (err) {
    console.error(`❌ Failed to register commands for ${guild.name}:`, err);
  }
});

// ----------------------
// Slash Command Handling
// ----------------------
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild())
    return interaction.reply({
      content: "❌ Use commands inside a server.",
      flags: MessageFlags.Ephemeral
    });

  const guildId = interaction.guild.id;
  let config = (await kv.getConfig(guildId)) || { messages: {} };

  const isAdmin = interaction.member.permissions.has(
    PermissionFlagsBits.Administrator
  );
  if (!isAdmin)
    return interaction.reply({
      content: "❌ Admins only.",
      flags: MessageFlags.Ephemeral
    });

  // CREATE FLOW
  if (interaction.commandName === "create-role-message") {
    const name = interaction.options.getString("name");
    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message");

    config.messages[name] = { roleId: role.id, channelId: channel.id, message };
    await kv.setConfig(guildId, config);

    await interaction.reply(
      `✅ Flow **${name}** created for **${role.name}** in **${channel.name}**.`
    );
  }

  // EDIT FLOW
  if (interaction.commandName === "edit-role-message") {
    const name = interaction.options.getString("name");
    if (!config.messages[name])
      return interaction.reply({
        content: `⚠️ Flow **${name}** not found.`,
        flags: MessageFlags.Ephemeral
      });

    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message");

    if (role) config.messages[name].roleId = role.id;
    if (channel) config.messages[name].channelId = channel.id;
    if (message) config.messages[name].message = message;

    await kv.setConfig(guildId, config);
    await interaction.reply(`✅ Flow **${name}** updated.`);
  }

  // DELETE FLOW
  if (interaction.commandName === "delete-role-message") {
    const name = interaction.options.getString("name");
    if (!config.messages[name])
      return interaction.reply({
        content: `⚠️ Flow **${name}** not found.`,
        flags: MessageFlags.Ephemeral
      });

    delete config.messages[name];
    await kv.setConfig(guildId, config);
    await interaction.reply(`🗑️ Deleted flow **${name}**.`);
  }

  // LIST FLOWS
  if (interaction.commandName === "list-role-messages") {
    const entries = Object.entries(config.messages || {});
    if (!entries.length)
      return interaction.reply({
        content: "⚠️ No flows configured.",
        flags: MessageFlags.Ephemeral
      });

    const list = entries
      .map(
        ([n, f]) =>
          `• **${n}** → Role <@&${f.roleId}> in <#${f.channelId}> (${f.message.length} chars)`
      )
      .join("\n");

    return interaction.reply({
      content: `📋 Configured Flows:\n${list}`,
      flags: MessageFlags.Ephemeral
    });
  }
});

// ----------------------
// Helpers
// ----------------------
function guardKey(guildId, userId, roleId) {
  return `${guildId}:${userId}:${roleId}`;
}

function isGuarded(guildId, userId, roleId) {
  const key = guardKey(guildId, userId, roleId);
  const now = Date.now();
  const exp = sentGuard.get(key);
  if (exp && exp > now) return true;
  if (exp && exp <= now) sentGuard.delete(key);
  return false;
}

function setGuard(guildId, userId, roleId, ttlMs = 30_000) {
  sentGuard.set(guardKey(guildId, userId, roleId), Date.now() + ttlMs);
}

function confirmKey(guildId, userId, flowName) {
  return `${guildId}:${userId}:${flowName}`;
}

function waitForConfirmation(guildId, userId, flowName, timeoutMs = CONFIRM_TIMEOUT_MS) {
  const key = confirmKey(guildId, userId, flowName);

  // If a waiter already exists (shouldn't normally), replace it.
  if (confirmResolvers.has(key)) {
    console.warn(`♻️ Replacing existing confirmation waiter for ${key}`);
  }

  return new Promise(resolve => {
    const resolver = (confirmed = true) => {
      confirmResolvers.delete(key);
      resolve(confirmed);
    };
    confirmResolvers.set(key, resolver);

    if (timeoutMs && timeoutMs > 0) {
      setTimeout(() => {
        if (confirmResolvers.get(key) === resolver) {
          console.warn(`⏰ Confirmation timeout for ${key}`);
          // resolve(false) to indicate timeout; change to true if you want to auto-advance anyway
          resolver(false);
        }
      }, timeoutMs);
    }
  });
}

async function sendOnboardingForFlow(member, flowName, flow) {
  const channel = member.guild.channels.cache.get(flow.channelId);
  if (!channel) return;

  try {
    await channel.permissionOverwrites.edit(member.id, { ViewChannel: true });
    console.log(`👁️ Gave ${member.user.tag} access to ${channel.name}`);
  } catch (err) {
    console.warn(`⚠️ Could not modify ${channel?.name}:`, err.message);
  }

  let formattedMessage = flow.message
    .replace(/{user}/g, `<@${member.id}>`)
    .replace(/{role}/g, `<@&${flow.roleId}>`)
    .replace(/\s{2,}/g, "\n\n")
    .replace(/(?<!\n)\.\s/g, ".\n")
    .replace(/(?<!\n):\s/g, ":\n");

  const customId = `confirm_${flowName}_${member.id}`;
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel("✅ I’ve read it")
    .setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(button);

  await channel.send({ content: formattedMessage, components: [row] });
  console.log(`📨 Sent onboarding for ${member.user.tag} (${flowName})`);

  // Briefly remove the role to force confirmation flow
  setTimeout(async () => {
    try {
      await member.roles.remove(flow.roleId);
      console.log(`⏳ Temporarily removed ${flow.roleId} from ${member.user.tag}`);
    } catch (err) {
      console.error(`❌ Failed to remove role:`, err);
    }
  }, 1000);
}

// ----------------------
// Runner: processes a user's pending batch sequentially
// Only proceeds to next flow after confirmation
// ----------------------
async function runBatch(memberKey, member) {
  const { guild } = member;

  while (true) {
    const entry = pendingBatches.get(memberKey);
    if (!entry || entry.flows.length === 0) {
      pendingBatches.delete(memberKey);
      runners.delete(memberKey);
      return;
    }

    const batch = entry.flows.splice(0, entry.flows.length);

    for (const [flowName, flow] of batch) {
      // Dedupe for (guild:user:role) for a short TTL
      if (isGuarded(guild.id, member.id, flow.roleId)) {
        console.log(`⏭️ Skipping duplicate for ${member.user.tag} ${flow.roleId}`);
        continue;
      }
      setGuard(guild.id, member.id, flow.roleId);

      try {
        await sendOnboardingForFlow(member, flowName, flow);
      } catch (err) {
        console.error(`❌ Onboarding send error:`, err);
        continue;
      }

      // ⏸️ Wait here until the user confirms this flow (or timeout)
      console.log(`⏳ Waiting for confirmation of ${flowName} by ${member.user.tag}`);
      const confirmed = await waitForConfirmation(guild.id, member.id, flowName);

      if (confirmed) {
        console.log(`✅ Confirmation received for ${flowName} by ${member.user.tag}`);
      } else {
        console.warn(`🚫 No confirmation (timeout) for ${flowName} by ${member.user.tag}`);
        // Decide behavior on timeout:
        // - break;   // stop processing further flows
        // - continue; // skip this and try next (not recommended)
        // Default here: stop sending further flows until they confirm
        break;
      }

      // Small spacing before next flow to let Discord update UI
      await sleep(1500);
    }

    // Tiny pause to allow any new role-adds within the window to get batched
    await sleep(250);
  }
}

// ----------------------
// Role Added → Batch + Sequential Runner
// ----------------------
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config?.messages) return;

  // Skip if just confirmed
  if (
    recentlyConfirmed.has(guildId) &&
    recentlyConfirmed.get(guildId).has(newMember.id)
  )
    return;

  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());
  const addedRoles = [...newRoles].filter(r => !oldRoles.has(r));
  if (!addedRoles.length) return;

  const triggered = Object.entries(config.messages).filter(
    ([, f]) => addedRoles.includes(f.roleId)
  );
  if (!triggered.length) return;

  const memberKey = `${guildId}:${newMember.id}`;
  const existing = pendingBatches.get(memberKey);
  if (!existing) {
    pendingBatches.set(memberKey, { flows: [...triggered], timer: null });
  } else {
    existing.flows.push(...triggered);
  }

  const ref = pendingBatches.get(memberKey);
  if (ref.timer) clearTimeout(ref.timer);
  ref.timer = setTimeout(() => {
    ref.timer = null;
    if (!runners.has(memberKey)) {
      const run = runBatch(memberKey, newMember).catch(console.error);
      runners.set(memberKey, run);
    }
  }, 500);
});

// ----------------------
// Button Click → Confirm (with admin message) + resolve waiter
// ----------------------
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("confirm_")) return;

  const [, flowName, memberId] = interaction.customId.split("_");
  const guildId = interaction.guild.id;
  const config = await kv.getConfig(guildId);
  const flow = config?.messages?.[flowName];
  if (!flow) return;

  if (interaction.user.id !== memberId)
    return interaction.reply({
      content: "❌ This button isn’t for you.",
      flags: MessageFlags.Ephemeral
    });

  const member = await interaction.guild.members.fetch(memberId);
  const channel = interaction.guild.channels.cache.get(flow.channelId);

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(memberId);

  // ✅ Resolve any waiter for this (guild:user:flowName)
  const k = confirmKey(guildId, memberId, flowName);
  const resolver = confirmResolvers.get(k);
  if (resolver) {
    try {
      resolver(true); // unblocks the queue
    } catch (e) {
      console.warn(`⚠️ Failed to resolve confirmation for ${k}`, e);
    }
  }

  try {
    await member.roles.add(flow.roleId);

    const dmText = flow.message
      .replace(/{user}/g, member.user.toString())
      .replace(/{role}/g, `<@&${flow.roleId}>`)
      .replace(/\s{2,}/g, "\n\n")
      .replace(/(?<!\n)\.\s/g, ".\n")
      .replace(/(?<!\n):\s/g, ":\n");

    // 📨 DM copy
    try {
      await member.send(
        `📩 **Here’s a copy of your onboarding message for reference:**\n\n${dmText}`
      );
    } catch {
      console.warn(`⚠️ Could not DM ${member.user.tag}`);
    }

    // 🚪 Hide onboarding channel + post admin confirmation
    if (channel) {
      await channel.permissionOverwrites.edit(member.id, { ViewChannel: false });

      const timestamp = new Date().toLocaleString("en-GB", {
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      });

      await channel.send(
        `✅ <@${member.id}> has confirmed and been assigned <@&${flow.roleId}> — ${timestamp}`
      );

      console.log(
        `🚪 Hid ${channel.name} and logged confirmation for ${member.user.tag}`
      );
    }

    await interaction.reply({
      content: "✅ Role assigned and onboarding complete!",
      flags: MessageFlags.Ephemeral
    });
    console.log(`🎯 ${member.user.tag} confirmed and got ${flow.roleId}`);
  } catch (err) {
    console.error("❌ Role assign error:", err);
    await interaction.reply({
      content: "❌ Could not assign role.",
      flags: MessageFlags.Ephemeral
    });
  }

  setTimeout(() => {
    if (recentlyConfirmed.has(guildId))
      recentlyConfirmed.get(guildId).delete(memberId);
  }, 10000);
});

client.login(token);
