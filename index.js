require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType
} = require('discord.js');
const { MessageFlags } = require('discord-api-types/v10');
const kv = require('./kvRedis'); // Redis-backed config and onboarding store
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});
process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));
const rawToken = process.env.DISCORD_TOKEN;
const token = String(rawToken).trim();
console.log(`🔍 Token received: ${token.slice(0, 10)}...`);
if (!token || typeof token !== 'string' || token.length < 10) {
  console.error('❌ DISCORD_TOKEN is missing or malformed. Check Railway Variables.');
  process.exit(1);
}
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  client.guilds.cache.forEach(async guild => {
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
          opt.setName('channel').setDescription('Channel to post onboarding message').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('message').setDescription('Message content (use {user} to insert name)').setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName('edit-role-message')
        .setDescription('Edit an existing onboarding role message')
        .addStringOption(opt =>
          opt.setName('name').setDescription('New name (optional)').setRequired(false)
        )
        .addRoleOption(opt =>
          opt.setName('role').setDescription('New role (optional)').setRequired(false)
        )
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('New channel (optional)').addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('message').setDescription('New message (optional)').setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName('delete-role-message')
        .setDescription('Delete the active onboarding role message'),

      new SlashCommandBuilder()
        .setName('list-role-messages')
        .setDescription('View active onboarding role message configuration')
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      console.log(`✅ Slash commands registered for ${guild.name}`);
    } catch (err) {
      console.error(`❌ Failed to register commands for ${guild.name}:`, err);
    }
  });
});
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: '❌ Commands must be used in a server, not in DMs.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const member = interaction.member;
  const isAdmin = member.roles.cache.some(role => role.name.toLowerCase() === 'admin');
  if (!isAdmin) {
    await interaction.reply({
      content: '❌ You must have the **Admin** role to use this command.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const guildId = interaction.guild.id;
  let config = await kv.getConfig(guildId);
  if (!config) config = {};

  // === Command: create-role-message ===
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

    await interaction.reply(`✅ Role message created:\n• Name: **${name}**\n• Role: **${role.name}**\n• Channel: **${channel.name}**\n• Message: "${message}"`);
  }

  // === Command: edit-role-message ===
  if (interaction.commandName === 'edit-role-message') {
    const name = interaction.options.getString('name');
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');

    if (!config.roleId || !config.channelId || !config.message || !config.name) {
      await interaction.reply({
        content: '⚠️ No active config to edit.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (name) config.name = name;
    if (role) config.roleId = role.id;
    if (channel) config.channelId = channel.id;
    if (message) config.message = message;

    await kv.setConfig(guildId, config);

    await interaction.reply(`✅ Role message updated:\n• Name: **${config.name}**\n• Role: **${interaction.guild.roles.cache.get(config.roleId)?.name || 'Unknown'}**\n• Channel: **${interaction.guild.channels.cache.get(config.channelId)?.name || 'Unknown'}**\n• Message: "${config.message}"`);
  }

  // === Command: delete-role-message ===
  if (interaction.commandName === 'delete-role-message') {
    await kv.deleteConfig(guildId);
    await kv.setOnboarding(guildId, new Set());
    await interaction.reply('🗑️ Role message configuration deleted.');
  }

  // === Command: list-role-messages ===
  if (interaction.commandName === 'list-role-messages') {
    if (!config.roleId || !config.channelId || !config.message || !config.name) {
      await interaction.reply({
        content: '⚠️ No active role message configuration found.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const role = interaction.guild.roles.cache.get(config.roleId);
    const channel = interaction.guild.channels.cache.get(config.channelId);
    const message = config.message;
    const name = config.name;

    await interaction.reply({
      content: `📋 Active Role Message Configuration:\n• Name: **${name}**\n• Role: **${role?.name || 'Unknown'}**\n• Channel: **${channel?.name || 'Unknown'}**\n• Message: "${message}"`,
      flags: MessageFlags.Ephemeral
    });
  }
});
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config || !config.roleId || !config.channelId || !config.message) return;

  const onboardingSet = await kv.getOnboarding(guildId);
  const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
  if (!addedRoles.has(config.roleId)) return;

  if (onboardingSet.has(newMember.id)) {
    console.log(`⏸ ${newMember.user.tag} already in onboarding. Skipping.`);
    return;
  }

  const username = newMember.nickname || newMember.user.username;
  const confirmButton = new ButtonBuilder()
    .setCustomId(`confirm_read_${newMember.id}`)
    .setLabel('✅ I’ve read it')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(confirmButton);
  const fallbackChannel = newMember.guild.channels.cache.get(config.channelId);

  let messageSent = false;
  if (fallbackChannel) {
    try {
      await fallbackChannel.send({
        content: config.message.replace('{user}', username),
        components: [row]
      });
      console.log(`📨 Onboarding message sent to ${username}`);
      messageSent = true;
    } catch (err) {
      console.error(`❌ Failed to send onboarding message:`, err);
    }
  } else {
    console.error(`❌ Fallback channel not found`);
  }

  if (messageSent) {
    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);

    try {
      await newMember.roles.remove(config.roleId);
      console.log(`⏳ Role temporarily removed from ${username} until confirmation`);
    } catch (err) {
      console.error(`❌ Failed to remove role from ${username}:`, err);
    }
  }
});
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('confirm_read')) return;

  const memberId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config || !config.roleId) return;

  const member = await interaction.guild.members.fetch(memberId);
  const role = interaction.guild.roles.cache.get(config.roleId);

  if (!role) {
    await interaction.reply({
      content: '⚠️ Role not found.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.user.id !== memberId) {
    await interaction.reply({
      content: '❌ This button is not for you.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const onboardingSet = await kv.getOnboarding(guildId);
  onboardingSet.delete(memberId);
  await kv.setOnboarding(guildId, onboardingSet);

  try {
    await member.roles.add(role);
    await interaction.reply({
      content: '✅ Role assigned. Welcome aboard!',
      flags: MessageFlags.Ephemeral
    });
    console.log(`🎯 Role ${role.name} successfully reassigned to ${member.user.tag}`);
  } catch (error) {
    console.error(`❌ Failed to assign role:`, error);
    await interaction.reply({
      content: '❌ Could not assign role. Please check bot permissions.',
      flags: MessageFlags.Ephemeral
    });
  }
});
client.login(token);
