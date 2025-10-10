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

const serverConfig = new Map();           // Stores role/channel/message/name/messageId per guild
const activeOnboarding = new Map();       // Tracks users currently in onboarding flow

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

  const rest = new REST({ version: '10' }).setToken(token);
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

  try {
    const existing = await rest.get(Routes.applicationCommands(client.user.id));
    if (!existing.length) {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log(`📦 Slash commands registered globally`);
    } else {
      console.log(`📦 Slash commands already registered`);
    }
  } catch (err) {
    console.error(`❌ Failed to register commands:`, err);
  }
});
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
  }
});

// Button interaction handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('confirm_read')) return;

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

// ✅ Start the bot
client.login(token);
