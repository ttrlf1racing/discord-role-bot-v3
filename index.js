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
  ChannelType,
  EmbedBuilder
} = require('discord.js');
const { MessageFlags } = require('discord-api-types/v10');
const kv = require('./kvRedis'); // Redis-backed config store

const recentlyConfirmed = new Map(); // cooldown guard
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
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Role to assign after confirmation').setRequired(true)
        )
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post onboarding message').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('message').setDescription('Custom onboarding message (use {user} and {role})').setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName('delete-role-message')
        .setDescription('Delete onboarding message for a role')
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Role to delete message for').setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName('list-role-messages')
        .setDescription('List all configured onboarding messages')
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

  const guildId = interaction.guild.id;
  const member = interaction.member;
  const isAdmin = member.roles.cache.some(role => role.name.toLowerCase() === 'admin');
  if (!isAdmin) {
    await interaction.reply({
      content: '❌ You must have the **Admin** role to use this command.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.commandName === 'create-role-message') {
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');

    await kv.setRoleMessage(guildId, role.id, {
      channelId: channel.id,
      message
    });

    await interaction.reply(`✅ Onboarding message saved for role **${role.name}** in channel **${channel.name}**.`);
  }

  if (interaction.commandName === 'delete-role-message') {
    const role = interaction.options.getRole('role');
    await kv.deleteRoleMessage(guildId, role.id);
    await interaction.reply(`🗑️ Onboarding message deleted for role **${role.name}**.`);
  }

  if (interaction.commandName === 'list-role-messages') {
    const all = await kv.listRoleMessages(guildId);
    if (!all || Object.keys(all).length === 0) {
      await interaction.reply({
        content: '⚠️ No onboarding messages configured.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const lines = Object.entries(all).map(([roleId, data]) => {
      const role = interaction.guild.roles.cache.get(roleId);
      const channel = interaction.guild.channels.cache.get(data.channelId);
      return `• Role: **${role?.name || roleId}** → Channel: **${channel?.name || 'Unknown'}**`;
    });

    await interaction.reply({
      content: `📋 Configured onboarding messages:\n${lines.join('\n')}`,
      flags: MessageFlags.Ephemeral
    });
  }
});
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
  if (!addedRoles.size) return;

  for (const [roleId, role] of addedRoles) {
    const config = await kv.getRoleMessage(guildId, roleId);
    if (!config || !config.channelId || !config.message) continue;

    if (recentlyConfirmed.has(guildId) && recentlyConfirmed.get(guildId).has(newMember.id)) {
      console.log(`🛑 Skipping ${newMember.user.tag} — recently confirmed`);
      continue;
    }

    const onboardingSet = await kv.getOnboarding(guildId);
    if (onboardingSet.has(newMember.id)) {
      console.log(`⏸ ${newMember.user.tag} already in onboarding. Skipping.`);
      continue;
    }

    const username = newMember.nickname || newMember.user.username;
    const roleName = role.name;
    const channel = newMember.guild.channels.cache.get(config.channelId);
    if (!channel) continue;

    const confirmButton = new ButtonBuilder()
      .setCustomId(`confirm_read_${newMember.id}`)
      .setLabel('✅ I’ve read it')
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(confirmButton);

    const message = config.message
      .replace('{user}', username)
      .replace('{role}', roleName);

    try {
      await channel.send({
        content: message,
        components: [row]
      });
      console.log(`📨 Onboarding message sent to ${username}`);
    } catch (err) {
      console.error(`❌ Failed to send onboarding message:`, err);
      continue;
    }

    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);

    try {
      await newMember.roles.remove(roleId);
      console.log(`⏳ Role ${roleName} temporarily removed from ${username}`);
    } catch (err) {
      console.error(`❌ Failed to remove role:`, err);
    }
  }
});
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('confirm_read')) return;

  const memberId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;
  const member = await interaction.guild.members.fetch(memberId);

  const roleMessage = await kv.getRoleMessageByUser(guildId, memberId);
  if (!roleMessage || !roleMessage.roleId) {
    await interaction.reply({
      content: '⚠️ No role configuration found for this user.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const role = interaction.guild.roles.cache.get(roleMessage.roleId);
  if (!role) {
    await interaction.reply({
      content: '❌ Role not found.',
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
  if (onboardingSet.has(memberId)) {
    onboardingSet.delete(memberId);
    await kv.setOnboarding(guildId, onboardingSet);
    console.log(`🧼 Cleared onboarding state for ${member.user.tag}`);
  }

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(memberId);
  setTimeout(() => {
    recentlyConfirmed.get(guildId).delete(memberId);
  }, 5000);

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
