require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  ChannelType,
  REST,
  Routes,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder
} = require('discord.js');
const { MessageFlags } = require('discord-api-types/v10');
const kv = require('./kvRedis');

const recentlyConfirmed = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error('❌ DISCORD_TOKEN missing');
  process.exit(1);
}

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register commands for each guild
  for (const [guildId, guild] of client.guilds.cache) {
    const commands = [
      new SlashCommandBuilder()
        .setName('create-role-message')
        .setDescription('Configure onboarding role, channel, and message')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Name for this onboarding flow').setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Role to assign after confirmation').setRequired(true)
        )
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Channel to post onboarding message')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('message').setDescription('Message content (use {user})').setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName('list-role-messages')
        .setDescription('View active onboarding role message configuration'),

      new SlashCommandBuilder()
        .setName('delete-role-message')
        .setDescription('Delete onboarding role message configuration')
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
      console.log(`✅ Commands registered for ${guild.name}`);
    } catch (err) {
      console.error(`❌ Failed to register commands for ${guild.name}:`, err);
    }
  }
});

// 🧩 Slash Command Handling
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Use commands in a server.', flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guild.id;
  let config = await kv.getConfig(guildId);
  if (!config) config = {};

  const admin = interaction.member.permissions.has('Administrator');
  if (!admin)
    return interaction.reply({
      content: '❌ You must be an Administrator to use this command.',
      flags: MessageFlags.Ephemeral
    });

  if (interaction.commandName === 'create-role-message') {
    const name = interaction.options.getString('name');
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');

    config.name = name;
    config.roleId = role.id;
    config.channelId = channel.id;
    config.message = message;

    await kv.setConfig(guildId, config);
    await kv.setOnboarding(guildId, new Set());

    await interaction.reply(`✅ Config created:
• Name: **${name}**
• Role: **${role.name}**
• Channel: **${channel.name}**
• Message: "${message}"`);
  }

  if (interaction.commandName === 'list-role-messages') {
    if (!config.roleId || !config.channelId) {
      return interaction.reply({
        content: '⚠️ No onboarding setup found.',
        flags: MessageFlags.Ephemeral
      });
    }
    const role = interaction.guild.roles.cache.get(config.roleId);
    const channel = interaction.guild.channels.cache.get(config.channelId);
    await interaction.reply({
      content: `📋 Config:
• Name: **${config.name}**
• Role: **${role?.name}**
• Channel: **${channel?.name}**
• Message: "${config.message}"`,
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.commandName === 'delete-role-message') {
    await kv.deleteConfig(guildId);
    await kv.setOnboarding(guildId, new Set());
    await interaction.reply('🗑️ Configuration deleted.');
  }
});

// 🧩 When role is added → remove + send confirm message
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config || !config.roleId || !config.channelId || !config.message) return;

  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  if (!addedRoles.has(config.roleId)) return;

  const onboardingSet = await kv.getOnboarding(guildId);
  if (onboardingSet.has(newMember.id)) {
    console.log(`⏸ ${newMember.user.tag} already onboarding`);
    return;
  }

  const username = newMember.nickname || newMember.user.username;
  const confirmButton = new ButtonBuilder()
    .setCustomId(`confirm_read_${newMember.id}`)
    .setLabel('✅ I’ve read it')
    .setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(confirmButton);
  const channel = newMember.guild.channels.cache.get(config.channelId);

  if (channel) {
    await channel.send({
      content: config.message.replace('{user}', username),
      components: [row]
    });
    console.log(`📨 Sent onboarding message for ${username} in #${channel.name}`);
  }

  onboardingSet.add(newMember.id);
  await kv.setOnboarding(guildId, onboardingSet);

  try {
    await newMember.roles.remove(config.roleId);
    console.log(`⏳ Temporarily removed role ${config.roleId} from ${username}`);
  } catch (e) {
    console.error('❌ Role remove error:', e);
  }
});

// 🧩 Button interaction
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('confirm_read_')) return;

  const memberId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config || !config.roleId) return;

  if (interaction.user.id !== memberId)
    return interaction.reply({ content: '❌ Not your button.', flags: MessageFlags.Ephemeral });

  const member = await interaction.guild.members.fetch(memberId);
  const role = interaction.guild.roles.cache.get(config.roleId);

  if (!role)
    return interaction.reply({ content: '⚠️ Role not found.', flags: MessageFlags.Ephemeral });

  const onboardingSet = await kv.getOnboarding(guildId);
  onboardingSet.delete(memberId);
  await kv.setOnboarding(guildId, onboardingSet);

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(memberId);
  setTimeout(() => recentlyConfirmed.get(guildId).delete(memberId), 5000);

  try {
    await member.roles.add(role);
    await interaction.reply({ content: '✅ Role assigned. Welcome aboard!', flags: MessageFlags.Ephemeral });
    console.log(`🎯 ${member.user.tag} confirmed and got role ${role.id}`);
  } catch (e) {
    console.error('❌ Role assign error:', e);
  }
});

client.login(token);
