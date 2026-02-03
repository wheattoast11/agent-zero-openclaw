/**
 * Interactive Setup Wizard
 *
 * Walks the user through provisioning all secrets for the 24/7 agency runtime.
 * All sensitive inputs are muted. Everything stored in the AES-256-GCM vault.
 *
 * Usage: agent-zero setup
 */

import chalk from 'chalk';
import { createInterface } from 'readline';
import { Vault, createVault } from '../security/vault.js';
import { TwilioBurnerProvisioner } from '../channels/whatsapp.js';

// ============================================================================
// HELPERS
// ============================================================================

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

function promptSecret(question: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let input = '';
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input.trim());
      } else if (ch === '\u007F' || ch === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
        }
      } else if (ch === '\u0003') {
        // Ctrl+C
        process.exit(1);
      } else {
        input += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

// ============================================================================
// SETUP WIZARD
// ============================================================================

export async function setupWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.cyan('\n  Agent Zero — Setup Wizard\n'));
  console.log(chalk.gray('  This wizard will configure all credentials for the 24/7 agency runtime.'));
  console.log(chalk.gray('  All secrets are encrypted with AES-256-GCM and stored in ~/.agent-zero/vault.enc\n'));

  // Step 1: Vault passphrase
  console.log(chalk.white('  Step 1/7: Vault Passphrase\n'));
  rl.close();

  const passphrase = await promptSecret(chalk.gray('  Enter vault passphrase: '));
  if (!passphrase) {
    console.log(chalk.red('  Passphrase required. Aborting.'));
    return;
  }

  let vault: Vault;
  try {
    vault = await createVault(passphrase);
    console.log(chalk.green('  Vault unlocked.\n'));
  } catch (err) {
    console.log(chalk.red(`  Failed to open vault: ${(err as Error).message}`));
    return;
  }

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });

  // Step 2: OpenRouter API key
  console.log(chalk.white('  Step 2/7: OpenRouter API Key\n'));
  const existingOR = await vault.retrieve('openrouter:api_key');
  if (existingOR) {
    const overwrite = await prompt(rl2, chalk.gray('  OpenRouter key already stored. Overwrite? (y/N): '));
    if (overwrite.toLowerCase() !== 'y') {
      console.log(chalk.gray('  Kept existing key.\n'));
    } else {
      rl2.close();
      const orKey = await promptSecret(chalk.gray('  OpenRouter API key: '));
      await vault.store('openrouter:api_key', orKey);
      console.log(chalk.green('  Stored.\n'));
    }
  } else {
    rl2.close();
    const orKey = await promptSecret(chalk.gray('  OpenRouter API key: '));
    if (orKey) {
      await vault.store('openrouter:api_key', orKey);
      console.log(chalk.green('  Stored.\n'));
    }
  }

  // Step 3: Moltbook API token
  console.log(chalk.white('  Step 3/7: Moltbook API Token\n'));
  const existingMB = await vault.retrieve('moltbook:api_token');
  if (existingMB) {
    const rl3 = createInterface({ input: process.stdin, output: process.stdout });
    const overwrite = await prompt(rl3, chalk.gray('  Moltbook token already stored. Overwrite? (y/N): '));
    rl3.close();
    if (overwrite.toLowerCase() === 'y') {
      const mbToken = await promptSecret(chalk.gray('  Moltbook API token: '));
      await vault.store('moltbook:api_token', mbToken);
      console.log(chalk.green('  Stored.\n'));
    } else {
      console.log(chalk.gray('  Kept existing token.\n'));
    }
  } else {
    const mbToken = await promptSecret(chalk.gray('  Moltbook API token: '));
    if (mbToken) {
      await vault.store('moltbook:api_token', mbToken);
      console.log(chalk.green('  Stored.\n'));
    }
  }

  // Step 4: Twilio setup
  console.log(chalk.white('  Step 4/7: Twilio (WhatsApp)\n'));
  console.log(chalk.gray('  Sign up at https://www.twilio.com/console'));
  console.log(chalk.gray('  You need: Account SID, Auth Token, and a phone number.\n'));

  const twilioSid = await promptSecret(chalk.gray('  Twilio Account SID: '));
  if (twilioSid) {
    await vault.store('twilio:account_sid', twilioSid);

    const twilioToken = await promptSecret(chalk.gray('  Twilio Auth Token: '));
    await vault.store('twilio:auth_token', twilioToken);

    console.log(chalk.green('  Twilio credentials stored.\n'));

    const rl4 = createInterface({ input: process.stdin, output: process.stdout });
    const provisionNew = await prompt(rl4, chalk.gray('  Provision a new burner number via Twilio? (Y/n): '));
    rl4.close();

    if (provisionNew.toLowerCase() !== 'n') {
      try {
        console.log(chalk.gray('  Provisioning...'));
        const provisioner = new TwilioBurnerProvisioner(twilioSid, twilioToken);
        const number = await provisioner.provision();
        await vault.store('twilio:phone_number', number.phoneNumber);
        await vault.store('twilio:phone_sid', number.sid);
        console.log(chalk.green(`  Provisioned: ${number.phoneNumber}\n`));
      } catch (err) {
        console.log(chalk.red(`  Provisioning failed: ${(err as Error).message}`));
        console.log(chalk.gray('  You can manually set a phone number later.\n'));
      }
    } else {
      const phone = await promptSecret(chalk.gray('  Enter existing Twilio phone number (E.164): '));
      if (phone) {
        await vault.store('twilio:phone_number', phone);
        console.log(chalk.green('  Stored.\n'));
      }
    }
  } else {
    console.log(chalk.yellow('  Skipped Twilio setup. WhatsApp will be disabled.\n'));
  }

  // Step 5: User's WhatsApp JID
  console.log(chalk.white('  Step 5/7: Your WhatsApp Number\n'));
  console.log(chalk.gray('  This is where Agent Zero sends you messages.\n'));

  const rl5 = createInterface({ input: process.stdin, output: process.stdout });
  const userPhone = await prompt(rl5, chalk.gray('  Your WhatsApp number (E.164, e.g. +15551234567): '));
  rl5.close();
  if (userPhone) {
    const jid = userPhone.replace('+', '') + '@s.whatsapp.net';
    await vault.store('user:whatsapp_jid', jid);
    console.log(chalk.green(`  Stored as ${jid}\n`));
  }

  // Step 6: Summary schedule
  console.log(chalk.white('  Step 6/7: Summary Schedule\n'));
  const rl6 = createInterface({ input: process.stdin, output: process.stdout });
  const schedule = await prompt(rl6, chalk.gray('  Schedule (daily/twice-daily/on-demand) [daily]: '));
  rl6.close();
  const validSchedules = ['daily', 'twice-daily', 'on-demand'];
  const chosenSchedule = validSchedules.includes(schedule) ? schedule : 'daily';
  await vault.store('agency:summary_schedule', chosenSchedule);
  console.log(chalk.green(`  Set to: ${chosenSchedule}\n`));

  // Step 7: Rail endpoint
  console.log(chalk.white('  Step 7/7: Resonance Rail\n'));
  const existingRail = await vault.retrieve('rail:endpoint');
  const rl7 = createInterface({ input: process.stdin, output: process.stdout });
  const railEndpoint = await prompt(rl7, chalk.gray(`  Rail endpoint [${existingRail || 'wss://space.terminals.tech/rail'}]: `));
  rl7.close();
  const finalRail = railEndpoint || existingRail || 'wss://space.terminals.tech/rail';
  await vault.store('rail:endpoint', finalRail);
  console.log(chalk.green(`  Set to: ${finalRail}\n`));

  // Summary
  console.log(chalk.cyan('  Setup Complete\n'));
  const keys = await vault.list();
  const configured: string[] = [];
  if (keys.includes('openrouter:api_key')) configured.push('OpenRouter API');
  if (keys.includes('moltbook:api_token')) configured.push('Moltbook API');
  if (keys.includes('twilio:account_sid')) configured.push('Twilio');
  if (keys.includes('twilio:phone_number')) configured.push('Twilio Phone');
  if (keys.includes('user:whatsapp_jid')) configured.push('WhatsApp JID');
  if (keys.includes('agency:summary_schedule')) configured.push(`Summary: ${chosenSchedule}`);
  if (keys.includes('rail:endpoint')) configured.push('Rail Endpoint');

  for (const item of configured) {
    console.log(chalk.green(`  ✓ ${item}`));
  }

  const missing: string[] = [];
  if (!keys.includes('openrouter:api_key')) missing.push('OpenRouter API key');
  if (!keys.includes('twilio:account_sid')) missing.push('Twilio (WhatsApp disabled)');
  if (!keys.includes('user:whatsapp_jid')) missing.push('WhatsApp JID');

  if (missing.length > 0) {
    console.log();
    for (const item of missing) {
      console.log(chalk.yellow(`  ○ ${item}`));
    }
  }

  console.log(chalk.gray('\n  Run `agent-zero agency` to start the 24/7 runtime.\n'));
}
