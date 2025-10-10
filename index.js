require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, Events, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

client.commands = new Collection();

// Slash command definition
const sendRoleCommand = new SlashCommandBuilder()
  .setName('send-role-message')
  .setDescription('Admin-only: Send onboarding message with role confirmation button')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(option => option.setName('target_user').setDescription('User to receive the message').setRequired(true))
  .addRoleOption(option => option.setName('role').setDescription('Role to assign').setRequired(true))
  .addChannelOption(option => option.setName('channel').setDescription('Channel to post the message').setRequired(true))
  .addStringOption(option => option.setName('message').setDescription('Custom message content').setRequired(true));

client.commands.set(sendRoleCommand.name, {
  data: sendRoleCommand,
  async execute(interaction) {
    const targetUser = interaction.options.getUser('target_user');
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    const messageContent = interaction.options.getString('message');

    const embed = new EmbedBuilder()
      .setTitle(`Welcome ${targetUser.username}, you have been given the ${role.name} role.`)
      .setDescription(`${messageContent}\n\nPlease read the information above and click the button to confirm.`)
      .setColor(0x00AE86);

    const confirmButton = new ButtonBuilder()
      .setCustomId(`confirm_${targetUser.id}_${role.id}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(confirmButton);

    await channel.send({ content: `${targetUser}`, embeds: [embed], components: [row] });
    await interaction.reply({ content: '✅ Confirmation message sent.', ephemeral: true });
  }
});

// Register slash commands
client.once(Events.ClientReady, async () => {
  console.log(`Bot is online as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: [sendRoleCommand.toJSON()] }
    );
    console.log('✅ Slash command registered.');
  } catch (error) {
    console.error('❌ Failed to register command:', error);
  }
});

// Handle interactions
client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (command) {
      try {
        await command.execute(interaction);
      } catch (error) {
        console.error(error);
        await interaction.reply({ content: '❌ Error executing command.', ephemeral: true });
      }
    }
  }

  if (interaction.isButton()) {
    const [action, userId, roleId] = interaction.customId.split('_');
    if (action !== 'confirm') return;

    if (interaction.user.id !== userId) {
      return interaction.reply({ content: 'This button is not for you.', ephemeral: true });
    }

    const role = interaction.guild.roles.cache.get(roleId);
    const member = interaction.guild.members.cache.get(userId);

    if (!role || !member) {
      return interaction.reply({ content: 'Role or user not found.', ephemeral: true });
    }

    await member.roles.add(role);
    await interaction.reply({ content: `✅ You now have the ${role.name} role.`, ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
