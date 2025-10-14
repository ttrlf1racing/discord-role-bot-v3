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

const recentlyConfirmed = new Map();

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

// Register commands
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  for (const [guildId, guild] of client.guilds.cache) {
    const commands = [
      new SlashCommandBuilder()
        .setName("create-role-message")
        .setDescription("Create a named onboarding flow for a role (supports multiline via file upload).")
        .addStringOption(o => o.setName("name").setDescription("Flow name").setRequired(true))
        .addRoleOption(o => o.setName("role").setDescription("Role gated by this flow").setRequired(true))
        .addChannelOption(o =>
          o.setName("channel")
            .setDescription("Channel to post onboarding message")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName("message").setDescription("Inline message (Discord flattens newlines)").setRequired(false)
        )
        .addAttachmentOption(o =>
          o.setName("message_file").setDescription("Upload .txt to preserve line breaks/markdown").setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName("edit-role-message")
        .setDescription("Edit an existing onboarding flow.")
        .addStringOption(o => o.setName("name").setDescription("Flow name").setRequired(true))
        .addRoleOption(o => o.setName("role").setDescription("New role").setRequired(false))
        .addChannelOption(o =>
          o.setName("channel").setDescription("New channel").addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
        .addStringOption(o => o.setName("message").setDescription("New inline message").setRequired(false))
        .addAttachmentOption(o => o.setName("message_file").setDescription("Upload new .txt message").setRequired(false)),

      new SlashCommandBuilder()
        .setName("delete-role-message")
        .setDescription("Delete a named onboarding flow.")
        .addStringOption(o => o.setName("name").setDescription("Flow name").setRequired(true)),

      new SlashCommandBuilder()
        .setName("list-role-messages")
        .setDescription("List all configured onboarding flows.")
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

// helper: fetch uploaded .txt
async function fetchAttachmentText(attachment) {
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Failed to fetch attachment: ${res.status}`);
  return await res.text();
}

// Slash command handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild())
    return interaction.reply({ content: "❌ Use commands inside a server.", flags: MessageFlags.Ephemeral });

  const guildId = interaction.guild.id;
  let config = (await kv.getConfig(guildId)) || { messages: {} };

  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  if (!isAdmin)
    return interaction.reply({ content: "❌ Admins only.", flags: MessageFlags.Ephemeral });

  // CREATE FLOW
  if (interaction.commandName === "create-role-message") {
    const name = interaction.options.getString("name");
    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    const inlineMessage = interaction.options.getString("message");
    const file = interaction.options.getAttachment("message_file");

    let messageText = inlineMessage || "";
    if (file) {
      if (!file.name.toLowerCase().endsWith(".txt")) {
        return interaction.reply({ content: "⚠️ Please upload a .txt file.", flags: MessageFlags.Ephemeral });
      }
      messageText = await fetchAttachmentText(file);
    }

    if (!messageText)
      return interaction.reply({
        content: "⚠️ Provide a message or upload a .txt file.",
        flags: MessageFlags.Ephemeral
      });

    config.messages[name] = { roleId: role.id, channelId: channel.id, message: messageText };
    await kv.setConfig(guildId, config);

    await interaction.reply(`✅ Flow **${name}** created for role **${role.name}** in **${channel.name}**`);
  }

  // EDIT FLOW
  if (interaction.commandName === "edit-role-message") {
    const name = interaction.options.getString("name");
    if (!config.messages[name])
      return interaction.reply({ content: `⚠️ Flow **${name}** not found.`, flags: MessageFlags.Ephemeral });

    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    const inlineMessage = interaction.options.getString("message");
    const file = interaction.options.getAttachment("message_file");

    if (role) config.messages[name].roleId = role.id;
    if (channel) config.messages[name].channelId = channel.id;

    if (inlineMessage !== null && inlineMessage !== "")
      config.messages[name].message = inlineMessage;
    if (file) config.messages[name].message = await fetchAttachmentText(file);

    await kv.setConfig(guildId, config);
    await interaction.reply(`✅ Flow **${name}** updated.`);
  }

  // DELETE FLOW
  if (interaction.commandName === "delete-role-message") {
    const name = interaction.options.getString("name");
    if (!config.messages[name])
      return interaction.reply({ content: `⚠️ Flow **${name}** not found.`, flags: MessageFlags.Ephemeral });

    delete config.messages[name];
    await kv.setConfig(guildId, config);
    await interaction.reply(`🗑️ Deleted flow **${name}**.`);
  }

  // LIST FLOWS
  if (interaction.commandName === "list-role-messages") {
    const entries = Object.entries(config.messages || {});
    if (!entries.length)
      return interaction.reply({ content: "⚠️ No flows configured.", flags: MessageFlags.Ephemeral });

    const list = entries
      .map(([n, f]) => `• **${n}** → Role <@&${f.roleId}> in <#${f.channelId}>`)
      .join("\n");

    return interaction.reply({ content: `📋 Onboarding Flows:\n${list}`, flags: MessageFlags.Ephemeral });
  }
});

// When a user is given a role — send onboarding
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
    if (onboardingSet.has(newMember.id)) continue;

    const channel = newMember.guild.channels.cache.get(channelId);
    if (!channel) continue;

    const finalMessage = message
      .replace(/{user}/g, `<@${newMember.id}>`)
      .replace(/{role}/g, `<@&${roleId}>`)
      .replace(/\r?\n/g, "\n");

    const embed = new EmbedBuilder()
      .setTitle(`Onboarding: ${name}`)
      .setDescription(finalMessage)
      .setColor(0x2b2d31);

    const customId = `confirm_${name}_${newMember.id}`;
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
      console.log(`📨 Sent onboarding (${name}) to ${newMember.user.tag}`);
    } catch (err) {
      console.error("❌ Failed to send onboarding:", err);
      continue;
    }

    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);

    try {
      await newMember.roles.remove(roleId);
      console.log(`⏳ Temporarily removed role ${roleId} from ${newMember.user.tag}`);
    } catch (err) {
      console.error("❌ Failed to remove role:", err);
    }
  }
});

// Handle button click
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("confirm_")) return;

  const parts = interaction.customId.split("_");
  const flowName = parts[1];
  const memberId = parts[2];
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
  const onboardingSet = await kv.getOnboarding(guildId);
  onboardingSet.delete(member.id);
  await kv.setOnboarding(guildId, onboardingSet);

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(member.id);

  try {
    await member.roles.add(flow.roleId);
    await interaction.reply({
      content: "✅ Role assigned. Welcome aboard!",
      flags: MessageFlags.Ephemeral
    });
    console.log(`🎯 ${member.user.tag} confirmed ${flowName} → role ${flow.roleId}`);
  } catch (err) {
    console.error("❌ Role assign error:", err);
    await interaction.reply({
      content: "❌ Failed to assign role.",
      flags: MessageFlags.Ephemeral
    });
  }

  setTimeout(() => {
    recentlyConfirmed.get(guildId)?.delete(member.id);
  }, 10000);
});

client.login(token);
