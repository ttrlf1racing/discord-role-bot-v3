require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, Events } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// CONFIG: Set your target role ID and hosting channel ID
const TARGET_ROLE_ID = 'YOUR_ROLE_ID';
const HOSTING_CHANNEL_ID = 'YOUR_CHANNEL_ID';
const CUSTOM_MESSAGE = `This is your onboarding message. Please read it carefully before confirming.`;

// Bot ready
client.once(Events.ClientReady, () => {
  console.log(`Bot is online as ${client.user.tag}`);
});

// Watch for role assignment
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const hadRole = oldMember.roles.cache.has(TARGET_ROLE_ID);
  const hasRole = newMember.roles.cache.has(TARGET_ROLE_ID);

  if (!hadRole && hasRole) {
    const channel = newMember.guild.channels.cache.get(HOSTING_CHANNEL_ID);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle(`Welcome ${newMember.user.username}, you have been given the ${newMember.guild.roles.cache.get(TARGET_ROLE_ID).name} role.`)
      .setDescription(`${CUSTOM_MESSAGE}\n\nPlease read the information above and click the button to confirm.`)
      .setColor(0x00AE86);

    const confirmButton = new ButtonBuilder()
      .setCustomId(`confirm_${newMember.id}_${TARGET_ROLE_ID}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(confirmButton);

    await channel.send({ content: `${newMember}`, embeds: [embed], components: [row] });
  }
});

// Handle button interaction
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

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
  await interaction.reply({ content: `✅ You now have full access to the ${role.name} role.`, ephemeral: true });
});

client.login(process.env.DISCORD_TOKEN);
