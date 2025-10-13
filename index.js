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
  PermissionFlagsBits
} = require('discord.js');
const { MessageFlags } = require('discord-api-types/v10');
const kv = require('./kvRedis');

const recentlyConfirmed = new Map(); // guildId → Set of userIds

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
process.on('uncaughtException', e => console.error('Uncaught exception:', e));

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error('❌ Missing DISCORD_TOKEN');
  process.exit(1);
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const [id, guild] of client.guilds.cache) {
    const rest = new REST({ version: '10' }).setToken(token);
    const commands = [
      new SlashCommandBuilder()
        .setName('create-role-message')
        .setDescription('Create an onboarding message for a role.')
        .addStringOption(o => o.setName('name').setDescription('Flow name').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Role to manage').setRequired(true))
        .addChannelOption(o =>
          o
            .setName('channel')
            .setDescription('Channel to send the message')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName('message').setDescription('Message text (use {user})').setRequired(true)
        ),
      new SlashCommandBuilder().setName('list-role-messages').setDescription('List all onboarding flows'),
      new SlashCommandBuilder()
        .setName('delete-role-message')
        .setDescription('Delete a configured onboarding flow')
        .addStringOption(o => o.setName('name').setDescription('Flow name').setRequired(true))
    ].map(c => c.toJSON());
    await rest.put(Routes.applicationGuildCommands(client.user.id, id), { body: commands });
    console.log(`✅ Slash commands registered for ${guild.name}`);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const guildId = interaction.guild.id;
  const config = (await kv.getConfig(guildId)) || { messages: {} };

  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ Only admins can use this.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'create-role-message') {
    const name = interaction.options.getString('name');
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const msg = interaction.options.getString('message');
    config.messages[name] = { roleId: role.id, channelId: channel.id, message: msg };
    await kv.setConfig(guildId, config);
    return interaction.reply(`✅ Created onboarding flow **${name}** for role **${role.name}**.`);
  }

  if (interaction.commandName === 'list-role-messages') {
    const entries = Object.entries(config.messages);
    if (entries.length === 0)
      return interaction.reply({ content: '⚠️ No onboarding flows configured.', flags: MessageFlags.Ephemeral });
    const list = entries
      .map(([name, flow]) => `• **${name}** → Role <@&${flow.roleId}> in <#${flow.channelId}>`)
      .join('\n');
    return interaction.reply({ content: `📋 Onboarding Flows:\n${list}`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'delete-role-message') {
    const name = interaction.options.getString('name');
    if (!config.messages[name])
      return interaction.reply({ content: '⚠️ That flow does not exist.', flags: MessageFlags.Ephemeral });
    delete config.messages[name];
    await kv.setConfig(guildId, config);
    return interaction.reply(`🗑️ Deleted onboarding flow **${name}**.`);
  }
});

// --- Guild Member Role Update ---
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

    // --- skip if just confirmed ---
    if (recentlyConfirmed.get(guildId)?.has(newMember.id)) {
      console.log(`🛑 Skipping ${newMember.user.tag} — recently confirmed.`);
      continue;
    }

    // --- skip if already onboarding ---
    if (onboardingSet.has(newMember.id)) {
      console.log(`⏸ ${newMember.user.tag} still onboarding; ensuring no role.`);
      if (newMember.roles.cache.has(roleId)) {
        await newMember.roles.remove(roleId).catch(() => {});
      }
      continue;
    }

    // --- send onboarding message ---
    const channel = newMember.guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`❌ Invalid channel for flow ${name}`);
      return;
    }

    const username = newMember.displayName || newMember.user.username;
    const customId = JSON.stringify({ t: 'confirm', u: newMember.id, f: name });
    const button = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel('✅ I’ve read it')
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);

    try {
      await channel.send({
        content: message.replace('{user}', username),
        components: [row]
      });
      console.log(`📨 Sent onboarding message for ${newMember.user.tag} in #${channel.name}`);
    } catch (e) {
      console.error('❌ Failed to send onboarding message:', e);
    }

    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);

    try {
      await newMember.roles.remove(roleId);
      console.log(`⏳ Temporarily removed role ${roleId} from ${newMember.user.tag}`);
    } catch (e) {
      console.error(`❌ Could not remove role:`, e);
    }
  }
});

// --- Button Interaction ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

  let data;
  try {
    data = JSON.parse(interaction.customId);
  } catch {
    return;
  }
  if (data.t !== 'confirm') return;

  const guildId = interaction.guild.id;
  const config = await kv.getConfig(guildId);
  const flow = config?.messages?.[data.f];
  if (!flow) return;

  const member = await interaction.guild.members.fetch(data.u).catch(() => null);
  if (!member) return;

  if (interaction.user.id !== member.id)
    return interaction.reply({ content: '❌ This button isn’t for you.', flags: MessageFlags.Ephemeral });

  const onboardingSet = await kv.getOnboarding(guildId);
  onboardingSet.delete(member.id);
  await kv.setOnboarding(guildId, onboardingSet);

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(member.id);

  try {
    await member.roles.add(flow.roleId);
    await interaction.reply({ content: '✅ Verified! Role granted.', flags: MessageFlags.Ephemeral });
    console.log(`🎯 ${member.user.tag} confirmed and got role ${flow.roleId}`);
  } catch (e) {
    console.error(`❌ Could not assign role:`, e);
    await interaction.reply({ content: '❌ Failed to assign role.', flags: MessageFlags.Ephemeral });
  }

  // Remove from recentlyConfirmed after 10 seconds
  setTimeout(() => {
    recentlyConfirmed.get(guildId)?.delete(member.id);
  }, 10000);
});

client.login(token);
