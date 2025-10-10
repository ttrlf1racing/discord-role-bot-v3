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

const serverConfig = new Map();           // Stores role/channel/message per guild
const recentlyConfirmed = new Map();      // Tracks cooldown users per guild

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
        .setName('setrole')
        .setDescription('Set the role to assign on confirmation')
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Target role').setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription('Set the fallback channel for onboarding')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Target channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName('setmessage')
        .setDescription('Set the onboarding message')
        .addStringOption(opt =>
          opt.setName('text').setDescription('Message content (use {user} to insert name)').setRequired(true)
        )
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

  if (interaction.commandName === 'setrole') {
    const role = interaction.options.getRole('role');
    config.roleId = role.id;
    await interaction.reply(`✅ Role set to **${role.name}**`);
  }

  if (interaction.commandName === 'setchannel') {
    const channel = interaction.options.getChannel('channel');
    config.channelId = channel.id;
    await interaction.reply(`✅ Fallback channel set to **${channel.name}**`);
  }

  if (interaction.commandName === 'setmessage') {
    const message = interaction.options.getString('text');
    config.message = message;
    await interaction.reply(`✅ Onboarding message updated`);
  }
});

// Role assignment detection
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = serverConfig.get(guildId);
  if (!config || !config.roleId || !config.channelId || !config.message) return;

  const isCoolingDown = recentlyConfirmed.has(guildId) && recentlyConfirmed.get(guildId).has(newMember.id);
  if (isCoolingDown) {
    console.log(`⏸ Skipping role removal for ${newMember.user.tag} (cooldown active)`);
    return;
  }

  const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
  if (!addedRoles.has(config.roleId)) return;

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
    if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
    recentlyConfirmed.get(guildId).add(memberId);

    // Remove from cooldown after 10 seconds
    setTimeout(() => {
      recentlyConfirmed.get(guildId)?.delete(memberId);
    }, 10000);

    await interaction.reply({ content: '✅ Role assigned. Welcome aboard!', ephemeral: true });
    console.log(`🎯 Role ${role.name} successfully reassigned to ${member.user.tag}`);
  } catch (error) {
    console.error(`❌ Failed to assign role:`, error);
    await interaction.reply({ content: '❌ Could not assign role. Please check bot permissions.', ephemeral: true });
  }
});

client.login(token);
