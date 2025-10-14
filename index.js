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

async function fetchAttachmentText(attachment) {
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Failed to fetch attachment: ${res.status}`);
  return await res.text();
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  for (const [guildId, guild] of client.guilds.cache) {
    const commands = [
      new SlashCommandBuilder()
        .setName("create-role-message")
        .setDescription("Create a named onboarding flow for a role.")
        .addStringOption(o => o.setName("name").setDescription("Flow name").setRequired(true))
        .addRoleOption(o => o.setName("role").setDescription("Role to assign").setRequired(true))
        .addChannelOption(o =>
          o.setName("channel").setDescription("Channel to post onboarding message").addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addStringOption(o => o.setName("message").setDescription("Message content").setRequired(true)),

      new SlashCommandBuilder()
        .setName("edit-role-message")
        .setDescription("Edit an existing flow.")
        .addStringOption(o => o.setName("name").setDescription("Flow name").setRequired(true))
        .addRoleOption(o => o.setName("role").setDescription("New role").setRequired(false))
        .addChannelOption(o =>
          o.setName("channel").setDescription("New channel").addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
        .addStringOption(o => o.setName("message").setDescription("New message").setRequired(false)),

      new SlashCommandBuilder()
        .setName("delete-role-message")
        .setDescription("Delete a flow.")
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

// Slash command handling
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
    const message = interaction.options.getString("message");

    config.messages[name] = { roleId: role.id, channelId: channel.id, message };
    await kv.setConfig(guildId, config);
    await interaction.reply(`✅ Flow **${name}** created for **${role.name}** in **${channel.name}**.`);
  }

  // EDIT FLOW
  if (interaction.commandName === "edit-role-message") {
    const name = interaction.options.getString("name");
    if (!config.messages[name])
      return interaction.reply({ content: `⚠️ Flow **${name}** not found.`, flags: MessageFlags.Ephemeral });

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

// Send onboarding message when role added
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config?.messages) return;

  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  if (!addedRoles.size) return;

  const onboardingSet = await kv.getOnboarding(guildId);

  for (const [flowName, flow] of Object.entries(config.messages)) {
    const { roleId, channelId, message } = flow;
    if (!addedRoles.has(roleId)) continue;

    if (recentlyConfirmed.get(guildId)?.has(newMember.id)) continue;
    if (onboardingSet.has(newMember.id)) continue;

    const channel = newMember.guild.channels.cache.get(channelId);
    if (!channel) continue;

    // Reformat message for readability
    const formatted = message
      .replace(/{user}/g, `<@${newMember.id}>`)
      .replace(/{role}/g, `<@&${roleId}>`)
      .replace(/\s{2,}/g, "\n\n") // double spaces -> newlines
      .replace(/\. /g, ".\n");    // sentence spacing -> line breaks

    const customId = `confirm_${flowName}_${newMember.id}`;
    const button = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("✅ I’ve read it")
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);

    try {
      await channel.send({
        content: formatted,
        components: [row],
        allowedMentions: { users: [newMember.id], roles: [roleId] }
      });
      console.log(`📨 Sent onboarding for ${newMember.user.tag}`);
    } catch (err) {
      console.error(`❌ Failed to send onboarding for ${newMember.user.tag}:`, err);
    }

    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);

    try {
      await newMember.roles.remove(roleId);
      console.log(`⏳ Temporarily removed ${roleId} from ${newMember.user.tag}`);
    } catch (e) {
      console.error("❌ Failed to remove role:", e);
    }
  }
});

// Button handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("confirm_")) return;

  const [, flowName, memberId] = interaction.customId.split("_");
  const guildId = interaction.guild.id;
  const config = await kv.getConfig(guildId);
  const flow = config?.messages?.[flowName];
  if (!flow) return;

  if (interaction.user.id !== memberId)
    return interaction.reply({ content: "❌ This button isn’t for you.", flags: MessageFlags.Ephemeral });

  const member = await interaction.guild.members.fetch(memberId);
  const onboardingSet = await kv.getOnboarding(guildId);
  onboardingSet.delete(member.id);
  await kv.setOnboarding(guildId, onboardingSet);

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(member.id);

  try {
    await member.roles.add(flow.roleId);
    await interaction.reply({ content: "✅ Role assigned. Welcome aboard!", flags: MessageFlags.Ephemeral });
    console.log(`🎯 ${member.user.tag} confirmed and got ${flow.roleId}`);
  } catch (err) {
    console.error("❌ Role assign error:", err);
    await interaction.reply({ content: "❌ Could not assign role.", flags: MessageFlags.Ephemeral });
  }

  setTimeout(() => recentlyConfirmed.get(guildId)?.delete(member.id), 10000);
});

client.login(token);
