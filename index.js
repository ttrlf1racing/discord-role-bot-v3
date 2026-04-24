require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits
} = require("discord.js");
const { MessageFlags } = require("discord-api-types/v10");
const kv = require("./kvRedis");

// Dedupe guard so we don't double-DM if multiple updates arrive
const sentGuard = new Map(); // key "guild:user:role" -> expiresAt(ms)
const GUARD_TTL_MS = 30_000; // 30s

function guardKey(g, u, r) {
  return `${g}:${u}:${r}`;
}

function isGuarded(g, u, r) {
  const k = guardKey(g, u, r);
  const now = Date.now();
  const exp = sentGuard.get(k);
  if (exp && exp > now) return true;
  if (exp && exp <= now) sentGuard.delete(k);
  return false;
}

function setGuard(g, u, r) {
  sentGuard.set(guardKey(g, u, r), Date.now() + GUARD_TTL_MS);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ----------------------
// Slash Commands
// ----------------------
const getCommands = () => [
  new SlashCommandBuilder()
    .setName("create-role-message")
    .setDescription("Create a DM template for a tier role.")
    .addStringOption(o =>
      o.setName("name").setDescription("Template name").setRequired(true)
    )
    .addRoleOption(o =>
      o.setName("role").setDescription("Tier role to watch").setRequired(true)
    )
    .addRoleOption(o =>
      o
        .setName("tierheadrole")
        .setDescription("Tier Head role for this tier")
        .setRequired(false)
    )
    .addStringOption(o =>
      o
        .setName("message")
        .setDescription("DM text (use {user}, {tier}, {tierHeads} and \\n for new lines)")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("edit-role-message")
    .setDescription("Edit an existing DM template.")
    .addStringOption(o =>
      o.setName("name").setDescription("Template name").setRequired(true)
    )
    .addRoleOption(o =>
      o.setName("role").setDescription("New watched tier role").setRequired(false)
    )
    .addRoleOption(o =>
      o
        .setName("tierheadrole")
        .setDescription("New Tier Head role")
        .setRequired(false)
    )
    .addStringOption(o =>
      o
        .setName("message")
        .setDescription("New DM text (use \\n for new lines)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("delete-role-message")
    .setDescription("Delete a template.")
    .addStringOption(o =>
      o.setName("name").setDescription("Template name").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("list-role-messages")
    .setDescription("List all role → DM templates.")
].map(c => c.toJSON());

// ----------------------
// Register Commands
// ----------------------
async function registerCommandsForGuild(guildId) {
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = getCommands();

  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
    body: commands
  });
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await registerCommandsForGuild(guildId);
      console.log(`✅ Commands registered for ${guild.name}`);
    } catch (err) {
      console.error(`❌ Failed to register commands for ${guild?.name}:`, err);
    }
  }
});

client.on(Events.GuildCreate, async guild => {
  try {
    await registerCommandsForGuild(guild.id);
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

  if (!interaction.inGuild()) {
    return interaction.reply({
      content: "❌ Use commands inside a server.",
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  let config = (await kv.getConfig(guildId)) || { messages: {} };

  const isAdmin = interaction.member.permissions.has(
    PermissionFlagsBits.Administrator
  );

  if (!isAdmin) {
    return interaction.reply({
      content: "❌ Admins only.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.commandName === "create-role-message") {
    const name = interaction.options.getString("name");
    const role = interaction.options.getRole("role");
    const tierHeadRole = interaction.options.getRole("tierheadrole");
    const rawMessage = interaction.options.getString("message");
    const message = rawMessage.replace(/\\n/g, "\n");

    config.messages[name] = {
      roleId: role.id,
      tierHeadRoleId: tierHeadRole?.id || null,
      message
    };

    await kv.setConfig(guildId, config);

    return interaction.reply(
      `✅ Template **${name}** created for role **${role.name}**` +
      `${tierHeadRole ? ` with Tier Heads role **${tierHeadRole.name}**.` : "."}`
    );
  }

  if (interaction.commandName === "edit-role-message") {
    const name = interaction.options.getString("name");

    if (!config.messages[name]) {
      return interaction.reply({
        content: `⚠️ Template **${name}** not found.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const role = interaction.options.getRole("role");
    const tierHeadRole = interaction.options.getRole("tierheadrole");
    const rawMessage = interaction.options.getString("message");

    if (role) config.messages[name].roleId = role.id;
    if (tierHeadRole) config.messages[name].tierHeadRoleId = tierHeadRole.id;

    if (rawMessage !== null) {
      const message = rawMessage.replace(/\\n/g, "\n");
      config.messages[name].message = message;
    }

    await kv.setConfig(guildId, config);
    return interaction.reply(`✅ Template **${name}** updated.`);
  }

  if (interaction.commandName === "delete-role-message") {
    const name = interaction.options.getString("name");

    if (!config.messages[name]) {
      return interaction.reply({
        content: `⚠️ Template **${name}** not found.`,
        flags: MessageFlags.Ephemeral
      });
    }

    delete config.messages[name];
    await kv.setConfig(guildId, config);

    return interaction.reply(`🗑️ Deleted template **${name}**.`);
  }

  if (interaction.commandName === "list-role-messages") {
    const entries = Object.entries(config.messages || {});

    if (!entries.length) {
      return interaction.reply({
        content: "⚠️ No templates configured.",
        flags: MessageFlags.Ephemeral
      });
    }

    const list = entries
      .map(([n, f]) => {
        const tierHeadInfo = f.tierHeadRoleId
          ? ` | Tier Heads: <@&${f.tierHeadRoleId}>`
          : "";
        return `• **${n}** → Tier <@&${f.roleId}>${tierHeadInfo} (${(f.message || "").length} chars)`;
      })
      .join("\n");

    return interaction.reply({
      content: `📋 Templates:\n${list}`,
      flags: MessageFlags.Ephemeral
    });
  }
});

// ----------------------
// Role Added → DM the user the configured message
// ----------------------
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config?.messages) return;

  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());
  const addedRoles = [...newRoles].filter(r => !oldRoles.has(r));
  if (!addedRoles.length) return;

  // Make sure role member lists are populated
  try {
    await newMember.guild.members.fetch();
  } catch (err) {
    console.warn(`⚠️ Could not fully fetch guild members for ${newMember.guild.name}:`, err?.message || err);
  }

  for (const [name, flow] of Object.entries(config.messages)) {
    if (!addedRoles.includes(flow.roleId)) continue;

    if (isGuarded(guildId, newMember.id, flow.roleId)) {
      console.log(`⏭️ Skipping duplicate DM for ${newMember.user.tag} / ${flow.roleId}`);
      continue;
    }
    setGuard(guildId, newMember.id, flow.roleId);

    const tierRole = newMember.guild.roles.cache.get(flow.roleId);
    const tierName = tierRole?.name || "your tier";

    let tierHeadsText = "the Tier Heads";

    if (flow.tierHeadRoleId) {
      const tierHeadRole = newMember.guild.roles.cache.get(flow.tierHeadRoleId);

      if (tierHeadRole) {
        const tierHeadMentions = [...tierHeadRole.members.values()]
          .filter(member => !member.user.bot)
          .map(member => `<@${member.id}>`);

        if (tierHeadMentions.length === 1) {
          tierHeadsText = tierHeadMentions[0];
        } else if (tierHeadMentions.length > 1) {
          tierHeadsText = tierHeadMentions.join(", ");
        } else {
          tierHeadsText = `the holders of ${tierHeadRole.name}`;
        }
      }
    }

    const dmText = (flow.message || "")
      .replace(/{user}/g, newMember.user.toString())
      .replace(/{tier}/g, tierName)
      .replace(/{tierHeads}/g, tierHeadsText);

    try {
      await newMember.send(dmText || `You were given ${tierName}.`);
      console.log(`📩 DM sent to ${newMember.user.tag} for template ${name}`);
    } catch (err) {
      console.warn(`⚠️ Could not DM ${newMember.user.tag}: ${err?.message || err}`);
    }
  }
});

client.login(token);
