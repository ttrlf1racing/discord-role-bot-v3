Here you go — full file with the `console.log` fixed (single line) and a couple of “smart quotes” replaced to avoid encoding hiccups (e.g., `I've`). Drop-in replacement:

```js
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
  PermissionFlagsBits,
  AttachmentBuilder
} = require("discord.js");
const { MessageFlags } = require("discord-api-types/v10");
const kv = require("./kvRedis");

const recentlyConfirmed = new Map(); // guildId → Set(userIds)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
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
    .setDescription("List all configured onboarding flows."),

  // ---- NEW: Export reactions command ----
  new SlashCommandBuilder()
    .setName("export-reactions")
    .setDescription("Export all reactions from a message as CSV.")
    .addStringOption(o =>
      o
        .setName("message")
        .setDescription("Message URL or ID")
        .setRequired(true)
    )
    .addChannelOption(o =>
      o
        .setName("channel")
        .setDescription("Channel (required if passing a bare message ID)")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .addBooleanOption(o =>
      o
        .setName("include_user_ids")
        .setDescription("Include User IDs in the CSV (default: true)")
        .setRequired(false)
    )
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

  // EXPORT REACTIONS
  if (interaction.commandName === "export-reactions") {
    const raw = interaction.options.getString("message", true);
    const optChannel = interaction.options.getChannel("channel");
    const includeIds = interaction.options.getBoolean("include_user_ids") ?? true;

    await interaction.deferReply({ ephemeral: true });

    // Parse either a full URL or bare ID
    const parseMessageRef = (input) => {
      const urlMatch = input.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
      if (urlMatch) {
        return { guildId: urlMatch[1], channelId: urlMatch[2], messageId: urlMatch[3] };
      }
      return { messageId: input };
    };

    const ref = parseMessageRef(raw);

    // Resolve channel
    let channel = optChannel ?? null;
    if (!channel) {
      if (!ref.channelId) {
        return interaction.editReply("❌ Please provide a channel when using a bare message ID.");
      }
      channel = interaction.guild.channels.cache.get(ref.channelId);
      if (!channel) return interaction.editReply("❌ I can’t access that channel.");
    }

    // Fetch message
    const messageId = ref.messageId;
    if (!messageId) return interaction.editReply("❌ Could not find a message ID in your input.");
    let message;
    try {
      message = await channel.messages.fetch(messageId);
    } catch (err) {
      console.error("Fetch message failed:", err);
      return interaction.editReply("❌ I couldn’t fetch that message. Check the channel and message ID/URL.");
    }

    // Build CSV
    const header = includeIds ? "Emoji,User,User ID\n" : "Emoji,User\n";
    let csv = header;

    const addCsvLine = (emoji, user) => {
      const safeName = `${user.username}#${user.discriminator}`;
      csv += includeIds ? `${emoji},${safeName},${user.id}\n` : `${emoji},${safeName}\n`;
    };

    try {
      for (const [, reaction] of message.reactions.cache) {
        const emojiLabel = reaction.emoji?.id
          ? `${reaction.emoji.name}:${reaction.emoji.id}`
          : reaction.emoji?.name ?? "unknown";

        // paginate users (100 per page)
        let lastId = undefined;
        while (true) {
          const fetched = await reaction.users.fetch({ limit: 100, after: lastId });
          if (fetched.size === 0) break;

          for (const [, user] of fetched) addCsvLine(emojiLabel, user);

          lastId = [...fetched.keys()].pop();
          if (fetched.size < 100) break;
        }
      }
    } catch (err) {
      console.error("Fetch reaction users failed:", err);
      return interaction.editReply(
        "❌ I couldn’t fetch some reaction users. Ensure I have View Channel, Read Message History, and Read Reactions."
      );
    }

    if (csv === header) {
      return interaction.editReply("ℹ️ That message has no reactions to export.");
    }

    const file = new AttachmentBuilder(Buffer.from(csv, "utf8"), { name: "reactions.csv" });
    await interaction.editReply({ content: "✅ Export complete. Here’s your file:", files: [file] });
  }
});

// ----------------------
// Role Added → Send Onboarding
// ----------------------
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config?.messages) return;

  if (
    recentlyConfirmed.has(guildId) &&
    recentlyConfirmed.get(guildId).has(newMember.id)
  )
    return;

  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());
  const addedRoles = [...newRoles].filter(r => !oldRoles.has(r));
  if (!addedRoles.length) return;

  for (const [flowName, flow] of Object.entries(config.messages)) {
    if (!addedRoles.includes(flow.roleId)) continue;

    const channel = newMember.guild.channels.cache.get(flow.channelId);
    if (!channel) continue;

    try {
      await channel.permissionOverwrites.edit(newMember.id, {
        ViewChannel: true
      });
      console.log(`👁️ Gave ${newMember.user.tag} access to ${channel.name}`);
    } catch (err) {
      console.warn(`⚠️ Could not modify ${channel.name}:`, err.message);
    }

    let formattedMessage = flow.message
      .replace(/{user}/g, `<@${newMember.id}>`)
      .replace(/{role}/g, `<@&${flow.roleId}>`)
      .replace(/\s{2,}/g, "\n\n")
      .replace(/(?<!\n)\.\s/g, ".\n")
      .replace(/(?<!\n):\s/g, ":\n");

    const customId = `confirm_${flowName}_${newMember.id}`;
    const button = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("✅ I've read it")
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);

    try {
      await channel.send({
        content: formattedMessage,
        components: [row]
      });
      console.log(`📨 Sent onboarding for ${newMember.user.tag} (${flowName})`);
    } catch (err) {
      console.error(`❌ Failed to send onboarding:`, err);
      continue;
    }

    setTimeout(async () => {
      try {
        await newMember.roles.remove(flow.roleId);
        console.log(
          `⏳ Temporarily removed ${flow.roleId} from ${newMember.user.tag}`
        );
      } catch (err) {
        console.error(`❌ Failed to remove role:`, err);
      }
    }, 1000);
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
      await channel.permissionOverwrites.edit(member.id, {
        ViewChannel: false
      });

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

      console.log(`🚪 Hid ${channel.name} and logged confirmation for ${member.user.tag}`);
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
```

If anything else explodes, paste the new stack trace and I’ll zero in on it.
