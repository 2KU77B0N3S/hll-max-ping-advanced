import { config } from 'dotenv';
import pkg from 'discord.js';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';    

const { Client, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = pkg;

// Load environment variables
config();

const CRCON_SERVER = process.env.CRCON_SERVER;
const CRCON_API_KEY = process.env.CRCON_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!CRCON_SERVER || !CRCON_API_KEY || !DISCORD_TOKEN || !CHANNEL_ID) {
  throw new Error('Missing required environment variables: CRCON_SERVER, CRCON_API_KEY, DISCORD_TOKEN, and CHANNEL_ID');
}

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Configuration defaults
let pingConfig = {
  isRunning: true,
  intervalMinutes: 15,
  durationSeconds: 5,
  targetPing: 180,
  defaultPing: 2000,
  autoMode: true // New config for auto start-stop
};

let botMessageId = null;
let intervalId = null;
let playerCheckIntervalId = null; // New interval for player count check
const client = new Client({
  intents: ['Guilds', 'GuildMessages', 'MessageContent']
});

// Load saved configuration
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    const savedConfig = JSON.parse(data);
    pingConfig = { ...pingConfig, ...savedConfig };
    console.log('Loaded configuration from config.json');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error loading config:', error.message);
    }
    await saveConfig();
  }
}

// Save configuration
async function saveConfig() {
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(pingConfig, null, 2));
    console.log('Saved configuration to config.json');
  } catch (error) {
    console.error('Error saving config:', error.message);
  }
}

// API Functions
async function getMaxPing() {
  try {
    const response = await fetch(`${CRCON_SERVER}/api/get_max_ping_autokick`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CRCON_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.json();
    if (data.failed) {
      throw new Error(`API error: ${data.error || 'Invalid response'}`);
    }

    return data.result;
  } catch (error) {
    console.error('Error fetching max ping:', error.message);
    throw error;
  }
}

async function setMaxPing(max_ms) {
  try {
    const response = await fetch(`${CRCON_SERVER}/api/set_max_ping_autokick`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CRCON_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ max_ms })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.json();
    if (data.failed) {
      throw new Error(`API error: ${data.error || 'Failed to set max ping'}`);
    }

    return data.result;
  } catch (error) {
    console.error('Error setting max ping:', error.message);
    throw error;
  }
}

async function getGameState() {
  try {
    const response = await fetch(`${CRCON_SERVER}/api/get_gamestate`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CRCON_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.json();
    if (data.failed) {
      throw new Error(`API error: ${data.error || 'Invalid response'}`);
    }

    return data.result;
  } catch (error) {
    console.error('Error fetching gamestate:', error.message);
    throw error;
  }
}

// Ping Management
async function managePingCycle() {
  try {
    await setMaxPing(pingConfig.targetPing);
    console.log(`Set max ping to ${pingConfig.targetPing}ms`);

    await new Promise(resolve => setTimeout(resolve, pingConfig.durationSeconds * 1000));
    await setMaxPing(pingConfig.defaultPing);
    console.log(`Restored max ping to ${pingConfig.defaultPing}ms`);
  } catch (error) {
    console.error('Error in ping cycle:', error.message);
  }
}

function startPingCycle() {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(managePingCycle, pingConfig.intervalMinutes * 60 * 1000);
  managePingCycle();
}

function stopPingCycle() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

// Player Count Check
async function checkPlayerCount() {
  try {
    if (!pingConfig.autoMode) return; // Skip if auto mode is disabled

    const gamestate = await getGameState();
    const playerCount = gamestate.num_allied_players + gamestate.num_axis_players;
    console.log(`Player count: ${playerCount}`);

    if (playerCount >= 95 && !pingConfig.isRunning) {
      pingConfig.isRunning = true;
      startPingCycle();
      await saveConfig();
      console.log('Auto-started ping manager due to high player count');
      const channel = await client.channels.fetch(CHANNEL_ID);
      await updateEmbedAndButtons(channel);
    } else if (playerCount < 95 && pingConfig.isRunning) {
      pingConfig.isRunning = false;
      stopPingCycle();
      await setMaxPing(pingConfig.defaultPing);
      await saveConfig();
      console.log('Auto-stopped ping manager due to low player count');
      const channel = await client.channels.fetch(CHANNEL_ID);
      await updateEmbedAndButtons(channel);
    }
  } catch (error) {
    console.error('Error checking player count:', error.message);
  }
}

function startPlayerCountCheck() {
  if (playerCheckIntervalId) clearInterval(playerCheckIntervalId);
  playerCheckIntervalId = setInterval(checkPlayerCount, 10 * 1000); // Check every 10 seconds
}

// Embed and Button Updates
async function updateEmbedAndButtons(channel) {
  try {
    const embed = new EmbedBuilder()
      .setTitle('Ping Manager')
      .setColor(pingConfig.isRunning ? '#00ff00' : '#ff0000')
      .setTimestamp()
      .addFields(
        { name: 'Status', value: pingConfig.isRunning ? 'Running' : 'Stopped' },
        { name: 'Interval', value: `${pingConfig.intervalMinutes} minutes` },
        { name: 'Duration', value: `${pingConfig.durationSeconds} seconds` },
        { name: 'Target Ping', value: `${pingConfig.targetPing}ms` },
        { name: 'Auto Mode', value: pingConfig.autoMode ? 'Enabled' : 'Disabled' }
      );

    const startButton = new ButtonBuilder()
      .setCustomId('start')
      .setLabel('START')
      .setStyle(ButtonStyle.Success)
      .setDisabled(pingConfig.isRunning);

    const stopButton = new ButtonBuilder()
      .setCustomId('stop')
      .setLabel('STOP')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!pingConfig.isRunning);

    const intervalButton = new ButtonBuilder()
      .setCustomId('interval')
      .setLabel('INTERVAL')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pingConfig.isRunning);

    const durationButton = new ButtonBuilder()
      .setCustomId('duration')
      .setLabel('DURATION')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pingConfig.isRunning);

    const pingButton = new ButtonBuilder()
      .setCustomId('ping')
      .setLabel('PING')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pingConfig.isRunning);

    const autoButton = new ButtonBuilder()
      .setCustomId('auto')
      .setLabel(pingConfig.autoMode ? 'AUTO: ON' : 'AUTO: OFF')
      .setStyle(pingConfig.autoMode ? ButtonStyle.Success : ButtonStyle.Secondary);

    const row1 = new ActionRowBuilder().addComponents(startButton, stopButton, autoButton);
    const row2 = new ActionRowBuilder().addComponents(intervalButton, durationButton, pingButton);

    if (botMessageId) {
      const message = await channel.messages.fetch(botMessageId);
      await message.edit({ embeds: [embed], components: [row1, row2] });
    } else {
      const sentMessage = await channel.send({ embeds: [embed], components: [row1, row2] });
      botMessageId = sentMessage.id;
    }

    console.log('Embed and buttons updated');
  } catch (error) {
    console.error('Error updating embed and buttons:', error.message);
  }
}

// Discord Client Events
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await loadConfig();

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel.isTextBased()) {
      throw new Error('Specified channel is not a text channel');
    }

    const messages = await channel.messages.fetch({ limit: 100 });
    await channel.bulkDelete(messages, true);
    console.log('Channel cleared');

    await setMaxPing(pingConfig.defaultPing);
    if (pingConfig.isRunning) {
      startPingCycle();
    }

    startPlayerCountCheck(); // Start player count monitoring
    await updateEmbedAndButtons(channel);
  } catch (error) {
    console.error('Error during startup:', error.message);
    process.exit(1);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.message.id === botMessageId) {
    try {
      const channel = interaction.channel;

      switch (interaction.customId) {
        case 'start':
          await interaction.deferReply({ ephemeral: true });
          pingConfig.isRunning = true;
          startPingCycle();
          await saveConfig();
          await interaction.editReply({ content: 'Ping manager started!' });
          await updateEmbedAndButtons(channel);
          break;

        case 'stop':
          await interaction.deferReply({ ephemeral: true });
          pingConfig.isRunning = false;
          stopPingCycle();
          await setMaxPing(pingConfig.defaultPing);
          await saveConfig();
          await interaction.editReply({ content: 'Ping manager stopped!' });
          await updateEmbedAndButtons(channel);
          break;

        case 'interval':
          try {
            const intervalModal = new ModalBuilder()
              .setCustomId('interval_modal')
              .setTitle('Set Interval');
            const intervalInput = new TextInputBuilder()
              .setCustomId('interval_input')
              .setLabel('Interval in minutes (e.g., 15)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true);
            intervalModal.addComponents(new ActionRowBuilder().addComponents(intervalInput));
            await interaction.showModal(intervalModal);
          } catch (modalError) {
            console.error('Error showing interval modal:', modalError.message, modalError.stack);
            if (!interaction.deferred && !interaction.replied) {
              await interaction.reply({ content: 'Failed to show modal. Discord API may be unavailable. Please try again later.', ephemeral: true });
            }
          }
          break;

        case 'duration':
          try {
            const durationModal = new ModalBuilder()
              .setCustomId('duration_modal')
              .setTitle('Set Duration');
            const durationInput = new TextInputBuilder()
              .setCustomId('duration_input')
              .setLabel('Duration in seconds (e.g., 5)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true);
            durationModal.addComponents(new ActionRowBuilder().addComponents(durationInput));
            await interaction.showModal(durationModal);
          } catch (modalError) {
            console.error('Error showing duration modal:', modalError.message, modalError.stack);
            if (!interaction.deferred && !interaction.replied) {
              await interaction.reply({ content: 'Failed to show modal. Discord API may be unavailable. Please try again later.', ephemeral: true });
            }
          }
          break;

        case 'ping':
          try {
            const pingModal = new ModalBuilder()
              .setCustomId('ping_modal')
              .setTitle('Set Target Ping');
            const pingInput = new TextInputBuilder()
              .setCustomId('ping_input')
              .setLabel('Target ping in ms (e.g., 180)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true);
            pingModal.addComponents(new ActionRowBuilder().addComponents(pingInput));
            await interaction.showModal(pingModal);
          } catch (modalError) {
            console.error('Error showing ping modal:', modalError.message, modalError.stack);
            if (!interaction.deferred && !interaction.replied) {
              await interaction.reply({ content: 'Failed to show modal. Discord API may be unavailable. Please try again later.', ephemeral: true });
            }
          }
          break;

        case 'auto':
          await interaction.deferReply({ ephemeral: true });
          pingConfig.autoMode = !pingConfig.autoMode;
          await saveConfig();
          await interaction.editReply({ content: `Auto mode ${pingConfig.autoMode ? 'enabled' : 'disabled'}!` });
          await updateEmbedAndButtons(channel);
          break;
      }
    } catch (error) {
      console.error(`Error handling button ${interaction.customId}:`, error.message, error.stack);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: `Error: ${error.message}. Please try again later.`, ephemeral: true });
      }
    }
  } else if (interaction.isModalSubmit()) {
    try {
      const channel = interaction.channel;
      const value = parseInt(interaction.fields.getTextInputValue(interaction.customId.replace('_modal', '_input')));

      if (isNaN(value) || value <= 0) {
        await interaction.reply({ content: 'Invalid input. Please enter a positive number.', ephemeral: true });
        return;
      }

      switch (interaction.customId) {
        case 'interval_modal':
          pingConfig.intervalMinutes = value;
          if (pingConfig.isRunning) startPingCycle();
          await saveConfig();
          await interaction.reply({ content: `Interval set to ${value} minutes!`, ephemeral: true });
          break;

        case 'duration_modal':
          pingConfig.durationSeconds = value;
          await saveConfig();
          await interaction.reply({ content: `Duration set to ${value} seconds!`, ephemeral: true });
          break;

        case 'ping_modal':
          pingConfig.targetPing = value;
          await saveConfig();
          await interaction.reply({ content: `Target ping set to ${value}ms!`, ephemeral: true });
          break;
      }

      await updateEmbedAndButtons(channel);
    } catch (error) {
      console.error(`Error handling modal ${interaction.customId}:`, error.message, error.stack);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: `Error: ${error.message}. Please try again later.`, ephemeral: true });
      }
    }
  }
});

// Login to Discord
async function loginWithRetry(client, token, retries = 3, delay = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Login attempt ${i + 1}`);
      await client.login(token);
      console.log('Login successful');
      return;
    } catch (error) {
      console.error(`Login attempt ${i + 1} failed: ${error.message}`);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

loginWithRetry(client, DISCORD_TOKEN).catch(error => {
  console.error('Failed to login to Discord:', error.message);
  process.exit(1);
});
