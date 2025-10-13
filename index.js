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

const recentlyConfirmed = new Map(); // guildId → Set of userIds

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

if (!token || typeof token !== 'string' || token.length < 10) {
  console.error('❌ DISCORD_TOKEN is missing or malformed.');
  process.exit(1);
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  client.guilds.cache.forEach(async guild => {
    const commands = [
      new SlashCommandBuilder()
        .setName('create-role-message')
        .setDescription('Create a new onboarding flow')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Name for this onboarding flow').setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Role to assign after confirmation').setRequired(true)
        )
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post onboarding message')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('message').setDescription('Message content (use {user} to insert name)').setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName('edit-role-message')
        .setDescription('Edit an existing onboarding flow')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Flow name to edit').setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('role').setDescription('New role (optional)').setRequired(false)
        )
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('New channel (optional)')
            .addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('message').setDescription('New message (optional)').setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName('delete-role-message')
        .setDescription('Delete an onboarding flow')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Flow name to delete').setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName('list-role-messages')
        .setDescription('List all active onboarding flows')
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
      content: '❌ Commands must be used in a server, not DMs.',
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
  if (!config.messages) config.messages = {};

  // --- CREATE ---
  if (interaction.commandName === 'create-role-message') {
    const name = interaction.options.getString('name');
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');

    config.messages[name] = {
      roleId: role.id,
      channelId: channel.id,
      message
    };
    await kv.setConfig(guildId, config);

    await interaction.reply(
      `✅ Onboarding flow **${name}** created:\n• Role: **${role.name}**\n• Channel: **${channel.name}**\n• Message: "${message}"`
    );
  }

  // --- EDIT ---
  if (interaction.commandName === 'edit-role-message') {
    const name = interaction.options.getString('name');
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');

    if (!config.messages[name]) {
      await interaction.reply({ content: '⚠️ No flow found with that name.', flags: MessageFlags.Ephemeral });
      return;
    }

    const flow = config.messages[name];
    if (role) flow.roleId = role.id;
    if (channel) flow.channelId = channel.id;
    if (message) flow.message = message;
    await kv.setConfig(guildId, config);

    await interaction.reply(
      `✅ Onboarding flow **${name}** updated.\n• Role: **${interaction.guild.roles.cache.get(flow.roleId)?.name || 'Unknown'}**\n• Channel: **${interaction.guild.channels.cache.get(flow.channelId)?.name || 'Unknown'}**\n• Message: "${flow.message}"`
    );
  }

  // --- DELETE ---
  if (interaction.commandName === 'delete-role-message') {
    const name = interaction.options.getString('name');
    if (!config.messages[name]) {
      await interaction.reply({ content: '⚠️ No flow found with that name.', flags: MessageFlags.Ephemeral });
      return;
    }
    delete config.messages[name];
    await kv.setConfig(guildId, config);
    await interaction.reply(`🗑️ Deleted onboarding flow **${name}**.`);
  }

  // --- LIST ---
  if (interaction.commandName === 'list-role-messages') {
    const flows = Object.entries(config.messages);
    if (!flows.length) {
      await interaction.reply({ content: '⚠️ No onboarding flows configured.', flags: MessageFlags.Ephemeral });
      return;
    }

    const list = flows.map(([name, flow]) => {
      const role = interaction.guild.roles.cache.get(flow.roleId);
      const channel = interaction.guild.channels.cache.get(flow.channelId);
      return `• **${name}** → Role: ${role?.name || 'Unknown'}, Channel: ${channel?.name || 'Unknown'}, Message: "${flow.message}"`;
    }).join('\n');

    await interaction.reply({ content: `📋 **Configured Onboarding Flows:**\n${list}`, flags: MessageFlags.Ephemeral });
  }
});

// --- GUILD MEMBER UPDATE ---
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config?.messages) return;

  const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
  const onboardingSet = await kv.getOnboarding(guildId);

  for (const [name, flow] of Object.entries(config.messages)) {
    const { roleId, channelId, message } = flow;
    if (!addedRoles.has(roleId)) continue;

    if (recentlyConfirmed.has(guildId) && recentlyConfirmed.get(guildId).has(newMember.id)) {
      console.log(`🛑 Skipping update for ${newMember.user.tag} — recently confirmed`);
      continue;
    }
    if (onboardingSet.has(newMember.id)) {
      console.log(`⏸ ${newMember.user.tag} already in onboarding. Skipping.`);
      continue;
    }

    const username = newMember.nickname || newMember.user.username;
    const customId = JSON.stringify({
      t: 'confirm_read',
      user: newMember.id,
      flow: name
    });

    const confirmButton = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel('✅ I’ve read it')
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(confirmButton);

    const channel = newMember.guild.channels.cache.get(channelId);
    if (!channel) {
      console.error(`❌ Channel ${channelId} not found for flow ${name}`);
      continue;
    }

    try {
      await channel.send({
        content: message.replace('{user}', username),
        components: [row]
      });
      console.log(`📨 Sent onboarding message for ${name} to ${username}`);
      onboardingSet.add(newMember.id);
      await kv.setOnboarding(guildId, onboardingSet);

      try {
        await newMember.roles.remove(roleId);
        console.log(`⏳ Temporarily removed role ${roleId} from ${username}`);
      } catch (err) {
        console.error(`❌ Failed to remove role:`, err);
      }
    } catch (err) {
      console.error(`❌ Failed to send onboarding message:`, err);
    }
  }
});

// --- BUTTON HANDLER (CONFIRM READ) ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

  let data;
  try {
    data = JSON.parse(interaction.customId);
  } catch {
    return; // ignore unrelated buttons
  }

  if (data.t !== 'confirm_read') return;

  const memberId = data.user;
  const flowName = data.flow;
  const guildId = interaction.guild.id;

  const config = await kv.getConfig(guildId);
  if (!config?.messages?.[flowName]) {
    console.warn(`⚠️ No config for flow "${flowName}"`);
    return;
  }

  const flow = config.messages[flowName];
  const member = await interaction.guild.members.fetch(memberId);
  const role = interaction.guild.roles.cache.get(flow.roleId);

  if (!role) {
    await interaction.reply({ content: '⚠️ Role not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== memberId) {
    await interaction.reply({ content: '❌ This button is not for you.', flags: MessageFlags.Ephemeral });
    return;
  }

  const onboardingSet = await kv.getOnboarding(guildId);
  if (onboardingSet.has(memberId)) {
    onboardingSet.delete(memberId);
    await kv.setOnboarding(guildId, onboardingSet);
  }

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(memberId);
  setTimeout(() => recentlyConfirmed.get(guildId).delete(memberId), 5000);

  try {
    await member.roles.add(role);
    await interaction.reply({ content: '✅ Role assigned. Welcome aboard!', flags: MessageFlags.Ephemeral });
    console.log(`🎯 Role ${role.name} assigned to ${member.user.tag} for flow ${flowName}`);
  } catch (err) {
    console.error(`❌ Failed to assign role:`, err);
    await interaction.reply({ content: '❌ Could not assign role. Please check bot permissions.', flags: MessageFlags.Ephemeral });
  }
});

client.login(token);
