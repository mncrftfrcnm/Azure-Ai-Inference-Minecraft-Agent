import mineflayer from 'mineflayer'; 
import { mineflayer as prismarineViewer } from 'prismarine-viewer';
import puppeteer from 'puppeteer';
import winston from 'winston';
import fs from 'fs';
import path from 'path';

import ModelClient, { isUnexpected } from '@azure-rest/ai-inference';
import { AzureKeyCredential } from '@azure/core-auth';

import pkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pkg;
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';

const token = 'YOUR_TOKEN_HERE';
const endpoint = "https://models.inference.ai.azure.com";
const modelName = "Meta-Llama-3.1-8B-Instruct";

const azureClient = ModelClient(endpoint, new AzureKeyCredential(token));

// --- Logger Setup ---
const logger = winston.createLogger({
  level: 'error',
  format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

// --- Global Error Handling ---
function globalErrorHandler(error) {
  logger.error(error instanceof Error ? error.stack : error);
}

process.on('uncaughtException', (error) => {
  globalErrorHandler('Uncaught Exception: ' + error);
});

process.on('unhandledRejection', (reason, promise) => {
  globalErrorHandler('Unhandled Rejection at: ' + promise + ' reason: ' + reason);
});

// --- Minecraft Bot Configuration ---
const mcConfig = {
  host: 'your Minecraft server address', // your Minecraft server address
  port: 11111,
  username: 'botusername'
};

// --- Global Goal Progress ---
const goalProgress = {
  housesBuilt: 0,            
  otherGoalsCompleted: false 
};

// --- Global Conversation History ---
let conversationHistory = [
  { role: "system", content: "You are controlling a Minecraft bot in a Survival world. Your background data includes your inventory, nearby players, current biome, and more. Remember the last 9 steps to inform your decisions." }
];

/**
 * Adds a message to the conversation history.
 * Keeps the system prompt and the 9 most recent messages.
 */
function addMessage(message) {
  conversationHistory.push(message);
  if (conversationHistory.length > 10) {
    conversationHistory.splice(1, conversationHistory.length - 10);
  }
}

// --- Global variable to hold the result of the previous command ---
let previousCommandResult = "None";

// --- Helper Functions ---
// Fix invalid JSON strings returned by the LLM (e.g., {x:91.5, y:72, z:-116.5})
function fixInvalidJSON(str) {
  // Add quotes around unquoted keys and replace single quotes with double quotes
  return str.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":').replace(/'/g, '"');
}

/**
 * Parses a position string and returns a Vec3 instance.
 */
function parsePosition(str) {
  const fixedStr = fixInvalidJSON(str);
  const obj = JSON.parse(fixedStr);
  return new Vec3(obj.x, obj.y, obj.z);
}

// Get biome name at the bot's current position (if available)
function getBiome() {
  try {
    const block = bot.blockAt(bot.entity.position);
    if (block && typeof bot.biomeAtBlock === 'function') {
      const biome = bot.biomeAtBlock(block);
      return biome ? biome.name : "Unknown";
    }
  } catch (e) {
    logger.error("Error fetching biome: " + e);
  }
  return "Unknown";
}

// List nearby players (excluding self)
function getNearbyPlayers() {
  return Object.values(bot.players)
    .filter(p => p.username !== bot.username)
    .map(p => p.username);
}

// --- Create the Mineflayer Bot ---
const bot = mineflayer.createBot(mcConfig);
bot.on('error', err => logger.error('Bot error: ' + err));
bot.on('end', () => logger.error('Bot has ended')); // Logging as error per your request

// --- Open the Prismarine Viewer ---
prismarineViewer(bot, { port: 3007 });
logger.error('Prismarine viewer started on port 3007.');

// --- Load the pathfinder plugin ---
bot.loadPlugin(pathfinder);

// --- Utility: Count diamonds in the bot’s inventory ---
function countDiamonds() {
  let diamondCount = 0;
  const items = bot.inventory.items();
  for (const item of items) {
    if (item.name === 'diamond' || item.name === 'minecraft:diamond') {
      diamondCount += item.count;
    }
  }
  return diamondCount;
}

// --- Video Recording (via screenshots) ---
async function recordBotView() {
  try {
    logger.error("Starting bot view recording for 5 minutes...");
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const folder = path.join(process.cwd(), 'recordings', `recording-${now}`);
    fs.mkdirSync(folder, { recursive: true });
    
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto('http://localhost:3007'); // Prismarine viewer URL
    
    const screenshotInterval = 5000; // take a screenshot every 5 seconds
    const duration = 5 * 60 * 1000;    // 5 minutes in ms
    const startTime = Date.now();MenyaZovutVova%5
    let counter = 0;
    
    while (Date.now() - startTime < duration) {
      const screenshotPath = path.join(folder, `screenshot-${counter}.png`);
      await page.screenshot({ path: screenshotPath });
      logger.error(`Captured screenshot: ${screenshotPath}`);
      counter++;
      await new Promise(resolve => setTimeout(resolve, screenshotInterval));
    }
    
    await browser.close();
    logger.error("Finished bot view recording. (You can later compile these images into a video using ffmpeg.)");
  } catch (error) {
    logger.error("Error during video recording: " + error);
  }
}

// Schedule video recording every 2 hours
setInterval(recordBotView, 2 * 60 * 60 * 1000);
// 1. mine at least 64 blocks of dirt
// --- Function: Call Azure Inference to get the next command ---
async function getNextCommand(state) {
  logger.error(`startedagain`);

  const prompt = `
You are controlling a Minecraft bot. The current state is:
${JSON.stringify(state, null, 2)}
Your goals are:
1. mine at least 64 blocks of dirt

3. Complete any other assigned tasks.
Complete your goals as fast as possible
You can also instruct the bot to:
- Walk (e.g., "walk north for 5 seconds")
- Use pathfinding to navigate
- Mine blocks (e.g., "mine block at {x:10, y:64, z:15}")
- Build a house (e.g., "build house at {x:11, y:64, z:15}")
- Attack an entity (e.g., "attack entity at {x:12, y:64, z:15}")
- Craft an item (e.g., "craft item sword")
- Eat (e.g., "eat")
- Gather wood (e.g., "gather wood")
- Stop current movement (e.g., "stop")
- Report status (e.g., "status")
- Dig a column (e.g., "dig column")
- Pick up items (e.g., "pickup")
- Chop tree (e.g., "chop tree")
- List nearby ores (e.g., "list ores")
- Report surroundings (e.g., "report surroundings")
What should the bot do next? Respond with one clear command. Return only the command, with no additional response.
in your responce you should not return any special characters like "
you can only use the comamnd we provided you with, only in the way we provide you with
`;

  // Append the new user prompt to our conversation history.
  addMessage({ role: "user", content: prompt });

  try {
    const response = await azureClient.path("/chat/completions").post({
      body: {
        messages: conversationHistory,
        temperature: 1.3,
        top_p: 1.0,
        max_tokens: 700,
        model: modelName
      }
    });
    if (isUnexpected(response)) {
      throw new Error(response.body.error);
    }
    const command = response.body.choices[0].message.content.trim();
    logger.error(`LLM returned command: ${command}`);
    // Append the assistant's response to the conversation history.
    addMessage({ role: "assistant", content: command });
    return command;
  } catch (error) {
    logger.error("Error from Azure Inference: " + error);
    return null;
  }
}

// --- Simulated House-Building Routine ---
async function buildHouse(pos) {
  logger.error(`Starting to build a 5x5 house at ${JSON.stringify(pos)}...`);
  await new Promise(resolve => setTimeout(resolve, 5000)); // simulate build time
  goalProgress.housesBuilt += 1;
  previousCommandResult = `House built at ${JSON.stringify(pos)}. Total houses built: ${goalProgress.housesBuilt}`;
  logger.error(previousCommandResult);
}

// --- Additional Functions ---

// Chop tree: Find a nearby wood block and dig it.
async function chopTree() {
  const woodBlock = bot.findBlock({
    matching: block => block && (block.name.includes("log") || block.name.includes("wood")),
    maxDistance: 6
  });
  if (woodBlock) {
    logger.error("Chopping tree block at " + JSON.stringify(woodBlock.position));
    bot.dig(woodBlock, (err) => {
      if (err) {
        logger.error("Error chopping tree: " + err);
        previousCommandResult = "Error chopping tree: " + err;
      } else {
        logger.error("Tree block chopped successfully.");
        previousCommandResult = "Tree block chopped successfully.";
      }
    });
  } else {
    previousCommandResult = "No wood block found nearby to chop.";
    logger.error(previousCommandResult);
  }
}

// List ores: Scan for nearby ore blocks and log them.
function listOres() {
  const ores = [];
  const radius = 5;
  const start = bot.entity.position.offset(-radius, -radius, -radius);
  const end = bot.entity.position.offset(radius, radius, radius);
  for (let x = start.x; x <= end.x; x++) {
    for (let y = start.y; y <= end.y; y++) {
      for (let z = start.z; z <= end.z; z++) {
        const pos = new Vec3(x, y, z);
        const block = bot.blockAt(pos);
        if (block && block.name.includes("ore")) {
          ores.push({ name: block.name, position: pos });
        }
      }
    }
  }
  if (ores.length > 0) {
    previousCommandResult = `Found ores: ${JSON.stringify(ores)}`;
    logger.error(previousCommandResult);
  } else {
    previousCommandResult = "No ores found nearby.";
    logger.error(previousCommandResult);
  }
}

// Report surroundings: Provide additional background data.
function reportSurroundings() {
  const biome = getBiome();
  const nearbyPlayers = getNearbyPlayers();
  const pos = bot.entity.position;
  previousCommandResult = `Current biome: ${biome}. Nearby players: ${nearbyPlayers.join(", ") || "None"}. Position: ${JSON.stringify(pos)}`;
  logger.error(previousCommandResult);
  bot.chat(previousCommandResult);
}

// --- Function: Parse and execute commands returned by the LLM ---
function executeCommand(command) {
  logger.error("Executing command: " + command);
  previousCommandResult = "Executing command: " + command;
  
  if (command.startsWith("walk")) {
    const match = command.match(/walk\s+(\w+)\s+for\s+(\d+)\s+seconds/i);
    if (match) {
      const direction = match[1].toLowerCase();
      const duration = parseInt(match[2]);
      const currentPos = bot.entity.position;
      const target = currentPos.clone();
      switch (direction) {
        case 'north': target.z -= duration; break;
        case 'south': target.z += duration; break;
        case 'east':  target.x += duration; break;
        case 'west':  target.x -= duration; break;
        default:
          logger.error("Unknown direction: " + direction);
          previousCommandResult = "Unknown direction: " + direction;
          return;
      }
      logger.error(`Setting pathfinder goal to ${target}`);
      bot.pathfinder.setGoal(new goals.GoalBlock(
        Math.floor(target.x),
        Math.floor(target.y),
        Math.floor(target.z)
      ));
      previousCommandResult = `Walking ${direction} for ${duration} seconds (target: ${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}).`;
    }
    
  } else if (command.startsWith("mine")) {
    const match = command.match(/mine\s+block\s+at\s+({.*})/i);
    if (match) {
      try {
        const pos = parsePosition(match[1]);
        const block = bot.blockAt(pos);
        if (block) {
          bot.dig(block, (err) => {
            if (err) {
              logger.error("Error mining block: " + err);
              previousCommandResult = "Error mining block: " + err;
            } else {
              logger.error("Block mined successfully.");
              previousCommandResult = "Block mined successfully.";
            }
          });
        } else {
          logger.error("No block found at position: " + JSON.stringify(pos));
          previousCommandResult = "No block found at position: " + JSON.stringify(pos);
        }
      } catch (e) {
        logger.error("Failed to parse position for mining: " + e);
        previousCommandResult = "Failed to parse position for mining: " + e;
      }
    }
    
  } else if (command.startsWith("place")) {
    const match = command.match(/place\s+block\s+at\s+({.*})/i);
    if (match) {
      try {
        const pos = parsePosition(match[1]);
        const referenceBlock = bot.blockAt(pos.offset(0, -1, 0));
        if (referenceBlock) {
          bot.placeBlock(referenceBlock, pos, (err) => {
            if (err) {
              logger.error("Error placing block: " + err);
              previousCommandResult = "Error placing block: " + err;
            } else {
              logger.error("Block placed successfully.");
              previousCommandResult = "Block placed successfully.";
            }
          });
        }
      } catch (e) {
        logger.error("Failed to parse position for placing: " + e);
        previousCommandResult = "Failed to parse position for placing: " + e;
      }
    }
    
  } else if (command.startsWith("build house")) {
    const match = command.match(/build\s+house\s+at\s+({.*})/i);
    if (match) {
      try {
        const pos = parsePosition(match[1]);
        buildHouse(pos);
      } catch (e) {
        logger.error("Failed to parse position for house building: " + e);
        previousCommandResult = "Failed to parse position for house building: " + e;
      }
    }
    
  } else if (command.startsWith("complete other goals")) {
    goalProgress.otherGoalsCompleted = true;
    previousCommandResult = "Other goals have been marked as completed.";
    logger.error(previousCommandResult);
    
  } else if (command.startsWith("attack")) {
    const match = command.match(/attack\s+entity\s+at\s+({.*})/i);
    if (match) {
      try {
        const pos = parsePosition(match[1]);
        const entities = Object.values(bot.entities).filter(e => {
          return e.position &&
                 Math.abs(e.position.x - pos.x) < 5 &&
                 Math.abs(e.position.y - pos.y) < 5 &&
                 Math.abs(e.position.z - pos.z) < 5;
        });
        if (entities.length > 0) {
          const target = entities[0];
          logger.error(`Attacking entity ${target.name} at ${JSON.stringify(target.position)}`);
          bot.attack(target);
          previousCommandResult = `Attacking entity ${target.name} at ${JSON.stringify(target.position)}`;
        } else {
          logger.error("No entity found near the given position to attack.");
          previousCommandResult = "No entity found near the given position to attack.";
        }
      } catch (e) {
        logger.error("Failed to parse position for attack command: " + e);
        previousCommandResult = "Failed to parse position for attack command: " + e;
      }
    }
    
  } else if (command.startsWith("craft")) {
    const match = command.match(/craft\s+item\s+(\w+)/i);
    if (match) {
      const itemName = match[1];
      logger.error(`Attempting to craft item: ${itemName}`);
      previousCommandResult = `Attempting to craft item: ${itemName} (simulation)`;
      bot.chat(`Crafting ${itemName}... (simulation)`);
    }
    
  } else if (command.startsWith("explore")) {
    const match = command.match(/explore\s+to\s+({.*})/i);
    if (match) {
      try {
        const pos = parsePosition(match[1]);
        logger.error(`Exploring towards position: ${JSON.stringify(pos)}`);
        previousCommandResult = `Exploring towards ${JSON.stringify(pos)} (using pathfinder)`;
        bot.pathfinder.setGoal(new goals.GoalBlock(
          Math.floor(pos.x),
          Math.floor(pos.y),
          Math.floor(pos.z)
        ));
      } catch (e) {
        logger.error("Failed to parse position for exploration: " + e);
        previousCommandResult = "Failed to parse position for exploration: " + e;
      }
    }
    
  } else if (command.startsWith("stop")) {
    bot.pathfinder.setGoal(null);
    logger.error("Pathfinding stopped.");
    previousCommandResult = "Pathfinding stopped.";
    
  } else if (command.startsWith("status")) {
    const health = bot.health;
    const food = bot.food;
    const pos = bot.entity.position;
    const biome = getBiome();
    const nearbyPlayers = getNearbyPlayers();
    previousCommandResult = `Status: Health=${health}, Food=${food}, Position=${JSON.stringify(pos)}, Biome=${biome}, Nearby players=${nearbyPlayers.join(", ") || "None"}`;
    bot.chat(previousCommandResult);
    logger.error(previousCommandResult);
    
  } else if (command.startsWith("dig column")) {
    const pos = bot.entity.position.offset(0, -1, 0);
    const block = bot.blockAt(pos);
    if (block) {
      bot.dig(block, (err) => {
        if (err) {
          if (err.message === 'Digging aborted') {
            logger.error("Digging aborted (likely due to pathfinder resetting).");
            previousCommandResult = "Digging aborted.";
          } else {
            logger.error("Error digging column: " + err);
            previousCommandResult = "Error digging column: " + err;
          }
        } else {
          logger.error("Dug column block successfully.");
          previousCommandResult = "Dug column block successfully.";
        }
      });
    } else {
      previousCommandResult = "No block to dig for column.";
    }
    
  } else if (command.startsWith("pickup")) {
    const items = Object.values(bot.entities).filter(e => e.name === 'item');
    if (items.length > 0) {
      const target = items[0];
      logger.error("Moving to pick up item at " + JSON.stringify(target.position));
      bot.pathfinder.setGoal(new goals.GoalNear(
        target.position.x,
        target.position.y,
        target.position.z,
        1
      ));
      previousCommandResult = "Moving to pick up item.";
    } else {
      previousCommandResult = "No items nearby to pick up.";
    }
    
  } else if (command.startsWith("chop tree")) {
    chopTree();
    
  } else if (command.startsWith("list ores")) {
    listOres();
    
  } else if (command.startsWith("report surroundings")) {
    reportSurroundings();
    
  } else {
    logger.error("Unknown command. Skipping.");
    previousCommandResult = "Unknown command executed.";
  }
}

// --- Check if All Goals Are Achieved ---
// --- Helper Function: Count specific items in the bot's inventory ---
function countItem(matcher) {
  let count = 0;
  const items = bot.inventory.items();
  for (const item of items) {
    if (matcher(item)) {
      count += item.count;
    }
  }
  return count;
}

// --- Check if All Goals Are Achieved ---
// Goal: 2 stacks of dirt (128 blocks) and 1 stack of wood (64 items)
function checkGoalState(state) {
  // Count dirt by matching either "dirt" or "minecraft:dirt"
  const dirtCount = countItem(item => item.name === 'dirt' || item.name === 'minecraft:dirt');
  // Count wood by checking for items that include "log" or "wood" in the name.
  const woodCount = countItem(item => item.name.includes('log') || item.name.includes('wood'));
  
  logger.error(`Current dirt count: ${dirtCount}`);
  logger.error(`Current wood count: ${woodCount}`);

  // Return true if the bot has at least 2 stacks of dirt and 1 stack of wood.
  if (dirtCount >= 128 && woodCount >= 64) {
    return true;
  }
  return false;
}

// --- Main Control Loop ---
bot.once('spawn', () => {
  const mcData = minecraftData(bot.version);
  const defaultMovements = new Movements(bot, mcData);
  bot.pathfinder.setMovements(defaultMovements);
  logger.error("Pathfinder loaded and movements set.");

  logger.error("Bot spawned. Starting control loop.");
  
  (async function controlLoop() {
    while (true) {
      // --- Sense: Gather the current state.
      const state = {
        position: bot.entity.position,
        inventory: bot.inventory.items().map(item => ({
          name: item.name,
          count: item.count
        })),
        blocksAround: {
          north: (bot.blockAt(bot.entity.position.offset(0, 0, -1)) || { name: "None" }).name,
          south: (bot.blockAt(bot.entity.position.offset(0, 0, 1)) || { name: "None" }).name,
          east:  (bot.blockAt(bot.entity.position.offset(1, 0, 0)) || { name: "None" }).name,
          west:  (bot.blockAt(bot.entity.position.offset(-1, 0, 0)) || { name: "None" }).name,
          up:    (bot.blockAt(bot.entity.position.offset(0, 1, 0)) || { name: "None" }).name,
          down:  (bot.blockAt(bot.entity.position.offset(0, -1, 0)) || { name: "None" }).name,
        },
        stats: {
          health: bot.health,
          food: bot.food
        },
        biome: getBiome(),
        nearbyPlayers: getNearbyPlayers(),
        time: new Date().toLocaleTimeString(),
        previousCommandResult: previousCommandResult,
        goals: {
          dirtRequired: 128, // 2 stacks of dirt
          woodRequired: 64   // 1 stack of wood
        }
      };
      

      // --- Think: Ask Azure Inference for the next command ---
      const command = await getNextCommand(state);
      if (command) {
        executeCommand(command);
      } else {
        logger.error("No command received. Retrying...");
      }
      
      // --- Goal Check ---
      if (checkGoalState(state)) {
        logger.error("All goals achieved! Exiting program.");
        process.exit(0);
      }
      
      // Wait before the next iteration.
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  })();
});