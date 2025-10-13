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
const kv = require('./kvRedis'); // Redis-backed config/onboarding storage

const recentlyConfirmed = new Map(); // guildId -> Set of userIds
const sentMessages = new Set(); // prevent double send per user+flow

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

process.on('unhandledRejection', e => console.error('Unhandled promise rejection:', e));
process.on('uncaughtException', e => console.error('Uncaught exception:', e));

const token = process.env.DISCORD_TOKEN?.trim();
if (!token || token.length < 10) {
  console.error('❌ DISCORD_TOKEN missing or invalid');
  process.exit(1);
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register slash commands for each guild
  client.guilds.cache.forEach(async guild => {
    const commands = [
      new SlashCommandBuilder()
        .setName('create-role-message')
        .setDescription('Create an onboarding message flow')
        .addStringOption(o => o.setName('name').setDescription('Flow name').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true))
        .addChannelOption(o =>
          o.setName('channel').setDescription('Channel to post message').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addStringOption(o => o.setName('message').setDescription('Message text (use {user})').setRequired(true)),

      new SlashCommandBuilder()
        .setName('edit-role-message')
        .setDescription('Edit an onboarding message flow')
        .addStringOption(o => o.setName('name').setDescription('Flow name').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('New role').setRequired(false))
        .addChannelOption(o =>
          o.setName('channel').setDescription('New channel').addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
        .addStringOption(o => o.setName('message').setDescription('New message').setRequired(false)),

      new SlashCommandBuilder()
        .setName('delete-role-message')
        .setDescription('Delete an onboarding message flow')
        .addStringOption(o => o.setName('name').setDescription('Flow name').setRequired(true)),

      new SlashCommandBuilder()
        .setName('list-role-messages')
        .setDescription('List all onboarding message flows')
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      console.log(`✅ Slash commands registered for ${guild.name}`);
    } catch (e) {
      console.error(`❌ Failed to register commands for ${guild.name}:`, e);
    }
  });
});

// --- Slash Commands ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: '❌ Use this in a server, not DMs.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guild.id;
  let config = await kv.getConfig(guildId);
  if (!config) config = { messages: {} };

  const member = interaction.member;
  const isAdmin = member.permissions.has('Administrator');
  if (!isAdmin) {
    await interaction.reply({ content: '❌ You need Administrator permissions to use this.', flags: MessageFlags.Ephemeral });
    return;
  }

  // --- Create flow ---
  if (interaction.commandName === 'create-role-message') {
    const name = interaction.options.getString('name');
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');

    config.messages[name] = { roleId: role.id, channelId: channel.id, message };
    await kv.setConfig(guildId, config);

    await interaction.reply(`✅ Created onboarding flow **${name}** → Role **${role.name}**, Channel **${channel.name}**.`);
  }

  // --- Edit flow ---
  if (interaction.commandName === 'edit-role-message') {
    const name = interaction.options.getString('name');
    if (!config.messages[name]) {
      await interaction.reply({ content: `⚠️ No flow named **${name}**.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');

    if (role) config.messages[name].roleId = role.id;
    if (channel) config.messages[name].channelId = channel.id;
    if (message) config.messages[name].message = message;

    await kv.setConfig(guildId, config);
    await interaction.reply(`✅ Updated flow **${name}**.`);
  }

  // --- Delete flow ---
  if (interaction.commandName === 'delete-role-message') {
    const name = interaction.options.getString('name');
    if (!config.messages[name]) {
      await interaction.reply({ content: `⚠️ No flow named **${name}**.`, flags: MessageFlags.Ephemeral });
      return;
    }

    delete config.messages[name];
    await kv.setConfig(guildId, config);
    await interaction.reply(`🗑️ Deleted flow **${name}**.`);
  }

  // --- List flows ---
  if (interaction.commandName === 'list-role-messages') {
    const entries = Object.entries(config.messages);
    if (entries.length === 0) {
      await interaction.reply({ content: '⚠️ No onboarding messages configured.', flags: MessageFlags.Ephemeral });
      return;
    }

    const list = entries
      .map(([name, flow]) => {
        const role = interaction.guild.roles.cache.get(flow.roleId);
        const channel = interaction.guild.channels.cache.get(flow.channelId);
        return `• **${name}** → Role: ${role?.name || 'Unknown'}, Channel: ${channel?.name || 'Unknown'}`;
      })
      .join('\n');

    await interaction.reply({ content: `📋 Active onboarding flows:\n${list}`, flags: MessageFlags.Ephemeral });
  }
});

// --- Role Update Watcher ---
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config?.messages) return;

  const onboardingSet = await kv.getOnboarding(guildId);
  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));

  for (const [name, flow] of Object.entries(config.messages)) {
    const { roleId, channelId, message } = flow;
    if (!addedRoles.has(roleId)) continue;

    const userKey = `${newMember.id}-${name}`;
    if (sentMessages.has(userKey)) {
      console.log(`⏸ Skipping duplicate onboarding message for ${newMember.user.tag} (${name})`);
      continue;
    }

    // Recently confirmed users are skipped
    if (recentlyConfirmed.has(guildId) && recentlyConfirmed.get(guildId).has(newMember.id)) {
      console.log(`🛑 Skipping update for ${newMember.user.tag} — recently confirmed`);
      continue;
    }

    // If already onboarding, make sure they don't keep the role
    if (onboardingSet.has(newMember.id)) {
      if (newMember.roles.cache.has(roleId)) {
        try {
          await newMember.roles.remove(roleId);
          console.log(`🚫 Role removed from ${newMember.user.tag} (still onboarding)`);
        } catch (e) {
          console.error(`❌ Failed to remove role from ${newMember.user.tag}:`, e);
        }
      }
      continue;
    }

    // --- Send onboarding message ---
    const username = newMember.displayName || newMember.user.username;
    const customId = JSON.stringify({ t: 'confirm_read', user: newMember.id, flow: name });
    const button = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel('✅ I’ve read it')
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);

    const channel = newMember.guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`❌ Cannot send onboarding message: Channel ${channelId} invalid`);
      continue;
    }

    try {
      await channel.send({
        content: message.replace('{user}', username),
        components: [row]
      });
      console.log(`📨 Sent onboarding message to ${username} in #${channel.name}`);
      sentMessages.add(userKey);
    } catch (e) {
      console.error(`❌ Failed to send onboarding message for ${username}:`, e);
      continue;
    }

    // --- Track onboarding state ---
    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);

    // --- Remove role until confirmation ---
    try {
      await newMember.roles.remove(roleId);
      console.log(`⏳ Temporarily removed role from ${username} until confirmation`);
    } catch (e) {
      console.error(`❌ Could not remove role from ${username}:`, e);
    }
  }
});

// --- Button Handler (Confirm Read) ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

  let data;
  try {
    data = JSON.parse(interaction.customId);
  } catch {
    return;
  }
  if (data.t !== 'confirm_read') return;

  const guildId = interaction.guild.id;
  const memberId = data.user;
  const flowName = data.flow;

  const config = await kv.getConfig(guildId);
  if (!config?.messages?.[flowName]) return;

  const flow = config.messages[flowName];
  const role = interaction.guild.roles.cache.get(flow.roleId);
  if (!role) {
    await interaction.reply({ content: '⚠️ Role not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== memberId) {
    await interaction.reply({ content: '❌ This button is not for you.', flags: MessageFlags.Ephemeral });
    return;
  }

  const member = await interaction.guild.members.fetch(memberId);
  const onboardingSet = await kv.getOnboarding(guildId);
  onboardingSet.delete(memberId);
  await kv.setOnboarding(guildId, onboardingSet);

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(memberId);
  setTimeout(() => recentlyConfirmed.get(guildId).delete(memberId), 5000);

  try {
    await member.roles.add(role);
    await interaction.reply({ content: '✅ You’ve been verified and your role restored. Welcome!', flags: MessageFlags.Ephemeral });
    console.log(`🎯 ${member.user.tag} confirmed onboarding for ${flowName}, role added back.`);
  } catch (e) {
    console.error(`❌ Failed to reassign role to ${member.user.tag}:`, e);
    await interaction.reply({ content: '❌ Could not assign role. Check bot permissions.', flags: MessageFlags.Ephemeral });
  }
});

client.login(token);
