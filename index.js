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

// 🚦 NEW: per-user onboarding queue (guildId:userId → Promise chain)
const onboardingQueue = new Map();
const sleep = ms => new Promise(res => setTimeout(res, ms));

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
// Helper: send onboarding for a single flow (used by queue)
// ----------------------
async function sendOnboardingForFlow(member, flowName, flow) {
  const channel = member.guild.channels.cache.get(flow.channelId);
  if (!channel) return;

  // Ensure user can see the channel while onboarding is open
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

  try {
    await channel.send({ content: formattedMessage, components: [row] });
    console.log(`📨 Sent onboarding for ${member.user.tag} (${flowName})`);
  } catch (err) {
    console.error(`❌ Failed to send onboarding:`, err);
    return;
  }

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
// Queue runner: ensure flows process sequentially per user
// ----------------------
function queueOnboarding(member, flowName, flow) {
  const key = `${member.guild.id}:${member.id}`;

  // Last queued job (or resolved if none)
  const last = onboardingQueue.get(key) || Promise.resolve();

  // Chain the next job to the previous
  const next = last
    .catch(() => {}) // swallow previous error to keep chain alive
    .then(async () => {
      // Small spacing so messages don't pile up and first isn’t buried
      await sleep(2000);
      await sendOnboardingForFlow(member, flowName, flow);
      // Extra tiny pause to give Discord time to render before the next one
      await sleep(500);
    });

  // Track the chain; clean up when settled
  onboardingQueue.set(
    key,
    next.finally(() => {
      // Only delete if this is still the latest promise for the key
      if (onboardingQueue.get(key) === next) onboardingQueue.delete(key);
    })
  );

  return next;
}

// ----------------------
// Role Added → Queue Onboarding (sequential per user)
// ----------------------
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config?.messages) return;

  // Skip if they just confirmed a flow (prevents immediate re-trigger)
  if (
    recentlyConfirmed.has(guildId) &&
    recentlyConfirmed.get(guildId).has(newMember.id)
  )
    return;

  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());
  const addedRoles = [...newRoles].filter(r => !oldRoles.has(r));
  if (!addedRoles.length) return;

  // Collect applicable flows (preserve config order)
  const triggered = Object.entries(config.messages).filter(
    ([, f]) => addedRoles.includes(f.roleId)
  );
  if (!triggered.length) return;

  // Queue each flow sequentially for this user
  for (const [flowName, flow] of triggered) {
    queueOnboarding(newMember, flowName, flow);
  }
});

// ----------------------
// Button Click → Confirm (with admin message)
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
