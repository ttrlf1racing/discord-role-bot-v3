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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const serverConfig = new Map();           // Stores role/channel/message/name per guild
const activeOnboarding = new Map();       // Tracks users currently in onboarding flow

// Error handling
process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));

// Token validation
const rawToken = process.env.DISCORD_TOKEN;
const token = String(rawToken).trim();
console.log(`🔍 Token received: ${token.slice(0, 10)}...`);
if (!token || typeof token !== 'string' || token.length < 10) {
  console.error('❌ DISCORD_TOKEN is missing or malformed. Check Railway Variables.');
  process.exit(1);
}

// Bot ready
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

// Slash command handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: '❌ Commands must be used in a server, not in DMs.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  const isAdmin = member.roles.cache.some(role => role.name.toLowerCase() === 'admin');
  if (!isAdmin) {
    await interaction.reply({ content: '❌ You must have the **Admin** role to use this command.', ephemeral: true });
    return;
  }

  const guildId = interaction.guild.id;
  if (!serverConfig.has(guildId)) serverConfig.set(guildId, {});
  const config = serverConfig.get(guildId);

  if (interaction.commandName === 'create-role-message') {
    const name = interaction.options.getString('name');
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');

    config.name = name;
    config.roleId = role.id;
    config.channelId = channel.id;
    config.message = message;

    await interaction.reply(`✅ Role message created:\n• Name: **${name}**\n• Role: **${role.name}**\n• Channel: **${channel.name}**\n• Message: "${message}"`);
  }

  if (interaction.commandName === 'list-role-messages') {
    if (!config.roleId || !config.channelId || !config.message || !config.name) {
      await interaction.reply({ content: '⚠️ No active role message configuration found.', ephemeral: true });
      return;
    }

    const role = interaction.guild.roles.cache.get(config.roleId);
    const channel = interaction.guild.channels.cache.get(config.channelId);
    const message = config.message;
    const name = config.name;

    await interaction.reply({
      content: `📋 Active Role Message Configuration:\n• Name: **${name}**\n• Role: **${role?.name || 'Unknown'}**\n• Channel: **${channel?.name || 'Unknown'}**\n• Message: "${message}"`,
      ephemeral: true
    });
  }
});

// Role assignment detection
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = serverConfig.get(guildId);
  if (!config || !config.roleId || !config.channelId || !config.message) return;

  if (!activeOnboarding.has(guildId)) activeOnboarding.set(guildId, new Set());
  const onboardingSet = activeOnboarding.get(guildId);

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
  if (fallbackChannel) {
    await fallbackChannel.send({
      content: config.message.replace('{user}', username),
      components: [row]
    });
    console.log(`📨 Onboarding message sent to ${username}`);
  } else {
    console.error(`❌ Fallback channel not found`);
  }

  onboardingSet.add(newMember.id);

  try {
    await newMember.roles.remove(config.roleId);
    console.log(`⏳ Role temporarily removed from ${username} until confirmation`);
  } catch (err) {
    console.error(`❌ Failed to remove role from ${username}:`, err);
  }
});

// Button interaction handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('confirm_read_')) return;

  const memberId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;
  const config = serverConfig.get(guildId);
  if (!config || !config.roleId) return;

  const member = await interaction.guild.members.fetch(memberId);
  const role = interaction.guild.roles.cache.get(config.roleId);

  if (!role) {
    await interaction.reply({ content: '⚠️ Role not found.', ephemeral: true });
    return;
  }

  if (interaction.user.id !== memberId) {
    await interaction.reply({ content: '❌ This button is not for you.', ephemeral: true });
    return;
  }

  try {
    await member.roles.add(role);
    activeOnboarding.get(guildId)?.delete(memberId);

    await interaction.reply({ content: '✅ Role assigned. Welcome aboard!', ephemeral: true });
    console.log(`🎯 Role ${role.name} successfully reassigned to ${member.user.tag}`);
  } catch (error) {
    console.error(`❌ Failed to assign role:`, error);
    await interaction.reply({ content: '❌ Could not assign role. Please check bot permissions.', ephemeral: true });
  }
});

client.login(token);
