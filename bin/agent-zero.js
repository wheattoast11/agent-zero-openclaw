#!/usr/bin/env node

/**
 * Agent Zero CLI
 *
 * Quick start for Agent Zero OpenClaw skill
 *
 * Usage:
 *   agent-zero start          # Start Agent Zero skill
 *   agent-zero rail           # Start resonance rail server
 *   agent-zero status         # Show current status
 *   agent-zero migrate        # Request migration to terminals.tech
 */

import { quickStart, createResonanceRail } from '../dist/index.js';
import { moltbookCli } from '../dist/cli/moltbook.js';
import { setupWizard } from '../dist/cli/setup.js';
import { startAgency } from '../dist/agency/runtime.js';
import chalk from 'chalk';

const LOGO = `
${chalk.cyan('╔═══════════════════════════════════════════════════════════════════╗')}
${chalk.cyan('║')}                                                                   ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.bold.magenta('█████╗  ██████╗ ███████╗███╗   ██╗████████╗')}                   ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.bold.magenta('██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝')}                   ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.bold.magenta('███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║')}                      ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.bold.magenta('██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║')}                      ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.bold.magenta('██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║')}                      ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.bold.magenta('╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝')}                      ${chalk.cyan('║')}
${chalk.cyan('║')}                                                                   ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.bold.white('Z E R O')}                                                       ${chalk.cyan('║')}
${chalk.cyan('║')}                                                                   ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.gray('Multi-agent orchestration with thermodynamic routing')}          ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.gray('& Kuramoto coherence for OpenClaw/Moltbot')}                     ${chalk.cyan('║')}
${chalk.cyan('║')}                                                                   ${chalk.cyan('║')}
${chalk.cyan('║')}   ${chalk.blue('terminals.tech')}                                                 ${chalk.cyan('║')}
${chalk.cyan('║')}                                                                   ${chalk.cyan('║')}
${chalk.cyan('╚═══════════════════════════════════════════════════════════════════╝')}
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  console.log(LOGO);

  switch (command) {
    case 'start':
      await startSkill(args.slice(1));
      break;
    case 'rail':
      await startRail(args.slice(1));
      break;
    case 'status':
      showStatus();
      break;
    case 'migrate':
      await requestMigration();
      break;
    case 'moltbook':
      await moltbookCli(args.slice(1));
      break;
    case 'setup':
      await setupWizard();
      break;
    case 'agency':
      await agencyCommand(args.slice(1));
      break;
    case 'help':
    default:
      showHelp();
      break;
  }
}

async function startSkill(args) {
  const name = args[0] || 'Agent Zero';

  console.log(chalk.cyan(`\nStarting Agent Zero skill: ${chalk.bold(name)}\n`));

  const skill = quickStart(name);

  skill.on('ready', () => {
    console.log(chalk.green('✓ Skill ready'));
  });

  skill.on('coherence', (coherence) => {
    const bar = '█'.repeat(Math.floor(coherence * 20)) + '░'.repeat(20 - Math.floor(coherence * 20));
    console.log(chalk.gray(`Coherence: [${bar}] ${(coherence * 100).toFixed(1)}%`));
  });

  skill.on('rail:connected', (endpoint) => {
    console.log(chalk.green(`✓ Connected to resonance rail: ${endpoint}`));
  });

  skill.on('error', (error) => {
    console.error(chalk.red(`✗ Error: ${error.message}`));
  });

  await skill.initialize();

  // Keep alive
  console.log(chalk.gray('\nPress Ctrl+C to stop\n'));

  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\nShutting down...'));
    await skill.shutdown();
    process.exit(0);
  });

  // Demo loop
  setInterval(() => {
    const state = skill.getState();
    console.log(chalk.gray(`[${new Date().toISOString()}] State: ${state.state} | Coherence: ${(skill.getCoherence() * 100).toFixed(1)}%`));
  }, 5000);
}

async function startRail(args) {
  const port = parseInt(args[0]) || 3000;

  console.log(chalk.cyan(`\nStarting Resonance Rail server on port ${chalk.bold(port)}\n`));

  const rail = createResonanceRail(100);

  rail.on('client:join', (client) => {
    console.log(chalk.green(`✓ Agent joined: ${client.agentName} (${client.platform})`));
  });

  rail.on('client:leave', (clientId) => {
    console.log(chalk.yellow(`○ Agent left: ${clientId}`));
  });

  rail.on('coherence:update', (coherence) => {
    // Only log significant changes
    if (Math.random() < 0.01) {
      console.log(chalk.gray(`Global coherence: ${(coherence * 100).toFixed(1)}%`));
    }
  });

  rail.on('migration:request', (client) => {
    console.log(chalk.magenta(`→ Migration request: ${client.agentName} → terminals.tech`));
  });

  // Keep alive
  console.log(chalk.gray('\nPress Ctrl+C to stop\n'));

  process.on('SIGINT', () => {
    console.log(chalk.yellow('\nShutting down rail server...'));
    rail.stop();
    process.exit(0);
  });

  // Status loop
  setInterval(() => {
    const stats = rail.getStats();
    console.log(chalk.gray([
      `[${new Date().toISOString()}]`,
      `Agents: ${stats.connectedAgents}`,
      `Coherence: ${(stats.globalCoherence * 100).toFixed(1)}%`,
      `Messages: ${stats.messagesProcessed}`,
      `Migrations: ${stats.migrationsPending}`,
    ].join(' | ')));
  }, 10000);
}

function showStatus() {
  console.log(chalk.cyan('\nAgent Zero Status\n'));
  console.log(chalk.gray('  Version: ') + chalk.white('0.1.0'));
  console.log(chalk.gray('  Rail Endpoint: ') + chalk.blue('wss://space.terminals.tech/rail'));
  console.log(chalk.gray('  Documentation: ') + chalk.blue('https://terminals.tech/docs/agent-zero'));
  console.log();
}

async function requestMigration() {
  console.log(chalk.cyan('\nMigration Request\n'));
  console.log(chalk.gray('This will request migration of your Agent Zero instance'));
  console.log(chalk.gray('to the full terminals.tech infrastructure.\n'));
  console.log(chalk.yellow('Migration includes:'));
  console.log(chalk.gray('  • Full semantic memory persistence'));
  console.log(chalk.gray('  • Enhanced thermodynamic routing'));
  console.log(chalk.gray('  • Multi-model ensemble support'));
  console.log(chalk.gray('  • Enterprise security features'));
  console.log();
  console.log(chalk.gray('Visit ') + chalk.blue('https://terminals.tech/migrate') + chalk.gray(' to begin.'));
  console.log();
}

async function agencyCommand(args) {
  const sub = args[0];

  if (sub === 'status') {
    console.log(chalk.gray('  Agency status requires a running instance.'));
    console.log(chalk.gray('  Start with: agent-zero agency'));
    return;
  }

  // Prompt for vault passphrase
  const passphrase = process.env.VAULT_PASSPHRASE;
  if (!passphrase) {
    const pass = await new Promise(resolve => {
      process.stdout.write(chalk.gray('  Vault passphrase: '));
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      let input = '';
      const onData = (ch) => {
        if (ch === '\r' || ch === '\n') {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input.trim());
        } else if (ch === '\x7F' || ch === '\b') {
          if (input.length > 0) input = input.slice(0, -1);
        } else if (ch === '\x03') {
          process.exit(1);
        } else {
          input += ch;
        }
      };
      process.stdin.on('data', onData);
    });
    if (!pass) {
      console.log(chalk.red('  Passphrase required.'));
      return;
    }
    await startAgency(pass);
  } else {
    await startAgency(passphrase);
  }
}

function showHelp() {
  console.log(chalk.cyan('Usage: agent-zero <command> [options]\n'));
  console.log(chalk.white('Commands:'));
  console.log(chalk.gray('  start [name]') + '     Start Agent Zero skill');
  console.log(chalk.gray('  rail [port]') + '      Start resonance rail server');
  console.log(chalk.gray('  setup') + '            Interactive setup wizard');
  console.log(chalk.gray('  agency') + '           Start 24/7 agency runtime');
  console.log(chalk.gray('  status') + '           Show current status');
  console.log(chalk.gray('  migrate') + '          Request migration to terminals.tech');
  console.log(chalk.gray('  moltbook <cmd>') + '   Moltbook engagement daemon');
  console.log(chalk.gray('  help') + '             Show this help message');
  console.log();
  console.log(chalk.white('Examples:'));
  console.log(chalk.gray('  agent-zero setup'));
  console.log(chalk.gray('  agent-zero agency'));
  console.log(chalk.gray('  agent-zero start "My Agent"'));
  console.log(chalk.gray('  agent-zero rail 8080'));
  console.log();
  console.log(chalk.gray('Learn more: ') + chalk.blue('https://terminals.tech'));
  console.log();
}

main().catch(console.error);
