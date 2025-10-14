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
  EmbedBuilder
} = require("discord.js");
const { MessageFlags } = require("discord-api-types/v10");
const kv = require("./kvRedis");

const recentlyConfirmed = new Map(); // guildId -> Set(userId)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
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

// Util: fetch attachment text
async function fetchAttachmentText(attachment) {
  // discord.js v14 runs on Node18—global fetch is available
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Failed to fetch attachment: ${res.status}`);
  return await res.text();
}

// Register commands
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  for (const [guildId, guild] of client.guilds.cache) {
    const commands = [
      new SlashCommandBuilder()
        .setName("create-role-message")
        .setDescription("Create a named onboarding flow for a role (supports multi-line via attachment).")
        .addStringOption(o => o.setName("name").setDescription("Flow name").setRequired(true))
        .addRoleOption(o => o.setName("role").setDescription("Role gated by this flow").setRequired(true))
        .addChannelOption(o =>
          o.setName("channel").setDescription("Channel to post onboarding message").addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addStringOption(o =>
          o.setName("message").setDescription("Inline message (Discord flattens newlines)").setRequired(false)
        )
        .addAttachmentOption(o =>
          o.setName("message_file").setDescription("Upload a .txt to preserve line breaks/formatting").setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName("edit-role-message")
        .setDescription("Edit an existing onboarding flow (you can re-upload message_file).")
        .addStringOption(o => o.setName("name").setDescription("Existing flow name").setRequired(true))
        .addRoleOption(o => o.setName("role").setDescription("New role").setRequired(false))
        .addChannelOption(o =>
          o.setName("channel").setDescription("New channel").addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
        .addStringOption(o => o.setName("message").setDescription("New inline message").setRequired(false))
        .addAttachmentOption(o => o.setName("message_file").setDescription("New .txt file").setRequired(false)),

      new SlashCommandBuilder()
        .setName("delete-role-message")
        .setDescription("Delete a named onboarding flow.")
        .addStringOption(o => o.setName("name").setDescription("Flow name").setRequired(true)),

      new SlashCommandBuilder()
        .setName("list-role-messages")
        .setDescription("List all configured flows.")
    ].map(c => c.toJSON());

    const rest = new REST({ version: "10" }).setToken(token);
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
      console.log(`✅ Commands registered for ${guild.name}`);
    } catch (err) {
      console.error(`❌ Failed to register commands for ${guild.name}:`, err);
    }
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    return interaction.reply({ content: "❌ Use commands in a server.", flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guild.id;
  let config = (await kv.getConfig(guildId)) || { messages: {} };

  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  if (!isAdmin) {
    return interaction.reply({ content: "❌ Administrator required.", flags: MessageFlags.Ephemeral });
  }

  // CREATE
  if (interaction.commandName === "create-role-message") {
    const name = interaction.options.getString("name");
    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    const inlineMessage = interaction.options.getString("message");
    const file = interaction.options.getAttachment("message_file");

    let messageText = inlineMessage || "";
    if (file) {
      if (!file.name.toLowerCase().endsWith(".txt")) {
        return interaction.reply({ content: "⚠️ Please upload a `.txt` file for message_file.", flags: MessageFlags.Ephemeral });
      }
      try {
        messageText = await fetchAttachmentText(file);
      } catch (e) {
        console.error(e);
        return interaction.reply({ content: "❌ Could not read the uploaded file.", flags: MessageFlags.Ephemeral });
      }
    }

    if (!messageText) {
      return interaction.reply({
        content: "⚠️ Provide `message` **or** upload `message_file` (.txt).",
        flags: MessageFlags.Ephemeral
      });
    }

    config.messages[name] = {
      roleId: role.id,
      channelId: channel.id,
      // Store exactly as-is; newlines preserved if provided via .txt
      message: messageText
    };

    await kv.setConfig(guildId, config);
    return interaction.reply(`✅ Created flow **${name}** → role **${role.name}** in **${channel.name}** (${messageText.length} chars).`);
  }

  // EDIT
  if (interaction.commandName === "edit-role-message") {
    const name = interaction.options.getString("name");
    if (!config.messages[name]) {
      return interaction.reply({ content: `⚠️ Flow **${name}** not found.`, flags: MessageFlags.Ephemeral });
    }
    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    const inlineMessage = interaction.options.getString("message");
    const file = interaction.options.getAttachment("message_file");

    if (role) config.messages[name].roleId = role.id;
    if (channel) config.messages[name].channelId = channel.id;

    if (inlineMessage !== null) {
      config.messages[name].message = inlineMessage; // (may be flattened by Discord UI)
    }
    if (file) {
      if (!file.name.toLowerCase().endsWith(".txt")) {
        return interaction.reply({ content: "⚠️ Please upload a `.txt` file for message_file.", flags: MessageFlags.Ephemeral });
      }
      try {
        const text = await fetchAttachmentText(file);
        config.messages[name].message = text;
      } catch (e) {
        console.error(e);
        return interaction.reply({ content: "❌ Could not read the uploaded file.", flags: MessageFlags.Ephemeral });
      }
    }

    await kv.setConfig(guildId, config);
    return interaction.reply(`✅ Updated flow **${name}**.`);
  }

  // DELETE
  if (interaction.commandName === "delete-role-message") {
    const name = interaction.options.getString("name");
    if (!config.messages[name]) {
      return interaction.reply({ content: `⚠️ Flow **${name}** not found.`, flags: MessageFlags.Ephemeral });
    }
    delete config.messages[name];
    await kv.setConfig(guildId, config);
    return interaction.reply(`🗑️ Deleted flow **${name}**.`);
  }

  // LIST
  if (interaction.commandName === "list-role-messages") {
    const entries = Object.entries(config.messages || {});
    if (!entries.length) {
      return interaction.reply({ content: "⚠️ No flows configured.", flags: MessageFlags.Ephemeral });
    }
    const list = entries
      .map(([n, f]) => `• **${n}** → Role <@&${f.roleId}> in <#${f.channelId}> (${f.message.length} chars)`)
      .join("\n");
    return interaction.reply({ content: `📋 Onboarding Flows:\n${list}`, flags: MessageFlags.Ephemeral });
  }
});

// Role Add → send message & remove role until confirm
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config?.messages) return;

  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  if (addedRoles.size === 0) return;

  const onboardingSet = await kv.getOnboarding(guildId);

  for (const [name, flow] of Object.entries(config.messages)) {
    const { roleId, channelId, message } = flow;
    if (!addedRoles.has(roleId)) continue;

    if (recentlyConfirmed.get(guildId)?.has(newMember.id)) continue;
    if (onboardingSet.has(newMember.id)) {
      // ensure role stays off during onboarding
      if (newMember.roles.cache.has(roleId)) {
        await newMember.roles.remove(roleId).catch(() => {});
      }
      continue;
    }

    const channel = newMember.guild.channels.cache.get(channelId);
    if (!channel) continue;

    // Build final message with placeholders
    const finalText = message
      .replace(/{user}/g, `<@${newMember.id}>`)
      .replace(/{role}/g, `<@&${roleId}>`)
      .replace(/\r?\n/g, "\n"); // normalize newlines

    // Use an embed to preserve formatting nicely (description supports markdown + newlines)
    const embed = new EmbedBuilder()
      .setTitle(`Onboarding: ${name}`)
      .setDescription(finalText)
      .setColor(0x2b2d31);

    const customId = JSON.stringify({ t: "confirm", u: newMember.id, f: name });
    const button = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("✅ I’ve read it")
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(button);

    try {
      await channel.send({
        embeds: [embed],
        components: [row],
        allowedMentions: { users: [newMember.id], roles: [roleId] }
      });
      console.log(`📨 Sent onboarding (${name}) to ${newMember.user.tag} in #${channel.name}`);
    } catch (e) {
      console.error("❌ Failed to send onboarding embed:", e);
      continue;
    }

    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);

    try {
      await newMember.roles.remove(roleId);
      console.log(`⏳ Temporarily removed role ${roleId} from ${newMember.user.tag}`);
    } catch (e) {
      console.error("❌ Could not remove role:", e);
    }
  }
});

// Confirm button handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

  let data;
  try {
    data = JSON.parse(interaction.customId);
  } catch {
    return;
  }
  if (data.t !== "confirm") return;

  const guildId = interaction.guild.id;
  const config = await kv.getConfig(guildId);
  const flow = config?.messages?.[data.f];
  if (!flow) return;

  const member = await interaction.guild.members.fetch(data.u).catch(() => null);
  if (!member) return;

  if (interaction.user.id !== member.id) {
    return interaction.reply({ content: "❌ This button isn’t for you.", flags: MessageFlags.Ephemeral });
  }

  // clear onboarding & add "recently confirmed"
  const onboardingSet = await kv.getOnboarding(guildId);
  onboardingSet.delete(member.id);
  await kv.setOnboarding(guildId, onboardingSet);

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(member.id);

  try {
    await member.roles.add(flow.roleId);
    await interaction.reply({ content: "✅ Role assigned. Welcome aboard!", flags: MessageFlags.Ephemeral });
    console.log(`🎯 ${member.user.tag} confirmed flow ${data.f} → role ${flow.roleId}`);
  } catch (e) {
    console.error("❌ Failed to assign role:", e);
    await interaction.reply({ content: "❌ Failed to assign role. Check bot permissions.", flags: MessageFlags.Ephemeral });
  }

  setTimeout(() => {
    recentlyConfirmed.get(guildId)?.delete(member.id);
  }, 10000);
});

client.login(token);
