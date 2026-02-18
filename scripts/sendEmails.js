#!/usr/bin/env node

import { emailSender } from '../src/emailSender.js';
import { CONFIG } from '../src/config.js';

/**
 * Script to send emails using stored OAuth tokens
 * Usage: node scripts/sendEmails.js [options]
 */

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  try {
    // Initialize the email sender
    await emailSender.initialize();

    if (options.list) {
      // List available users with tokens
      console.log('Available users with tokens:');
      const users = await emailSender.listAvailableUsers();

      if (users.length === 0) {
        console.log('No users with stored tokens found.');
        console.log('Please authenticate users first using the web interface.');
        return;
      }

      users.forEach((user, index) => {
        console.log(`${index + 1}. ${user.userKey}`);
        console.log(`   Email: ${user.email || 'Unknown'}`);
        console.log(`   Display Name: ${user.displayName || 'Unknown'}`);
        console.log(`   Expires: ${user.expiresAt || 'Unknown'}`);
        console.log(`   Saved: ${user.savedAt}`);
        console.log('');
      });

      return;
    }

    if (!options.userKey) {
      console.error('Error: --user-key is required unless using --list');
      showHelp();
      process.exit(1);
    }

    // Handle ramp-up reset if requested
    if (options.resetRampUp) {
      console.log(`🔄 Resetting ramp-up progress for user ${options.userKey}...`);
      await emailSender.resetRampUp(options.userKey, options.rampUpDays);
      console.log(`✅ Ramp-up reset to ${options.rampUpDays} days`);
      return;
    }

    // Check ramp-up status first
    const rampUpStatus = await emailSender.getRampUpStatus(options.userKey);
    console.log('🚀 Sending personalized gift card notification emails...');
    console.log('📊 Reading all CSV files in src/ directory');
    console.log('📈 Ramp-up Mode: Day', rampUpStatus.currentDay, 'of', rampUpStatus.rampUpDays);
    console.log('📊 Today\'s limit:', rampUpStatus.maxEmailsToday, 'emails (sent:', rampUpStatus.emailsSentToday + ')');
    console.log('⏱️  Delay: 1 minute between emails');
    console.log('📧 Template: Gift card reservation with placeholders');
    console.log(options.useButtons ? '🔗 Mode: Clickable buttons in email' : '📎 Mode: PDF attachment with QR code');
    if (options.qrUrl) {
      console.log('🔗 Custom QR URL:', options.qrUrl);
    }

    const result = await emailSender.sendPersonalizedEmails(options.userKey, {
      subject: options.subject || 'Reservation Confirmed - ##FIRSTNAME## ##LASTNAME## Gift Card Available',
      saveToSentItems: !options.noSave,
      usePdfAttachment: !options.useButtons, // Default to PDF attachment unless --use-buttons is set
      qrUrl: options.qrUrl // Custom URL for QR code
    });

    if (result.throttled) {
      console.log(`\n⏰ RAMP-UP LIMIT REACHED: Must wait ${result.waitHours} hours before next batch`);
      console.log(`Next batch available: ${new Date(Date.now() + (result.waitHours * 60 * 60 * 1000)).toLocaleString()}`);
      console.log(`Current progress: Day ${result.rampUpStatus.currentDay} of ${result.rampUpStatus.rampUpDays}`);
      console.log(`Today's limit: ${result.rampUpStatus.maxEmailsToday} emails`);
      return;
    }

    console.log(`\n✅ Batch Complete:`);
    console.log(`  📁 Total contacts processed: ${result.total}`);
    console.log(`  📤 Emails sent today: ${result.sent}/${result.rampUpStatus.maxEmailsToday} (ramp-up limit)`);
    console.log(`  ❌ Failed: ${result.failed}`);
    console.log(`  📈 Ramp-up progress: Day ${result.rampUpStatus.currentDay} of ${result.rampUpStatus.rampUpDays}`);

    if (!result.canSendMoreToday) {
      console.log(`  ⏰ Daily limit reached - next batch tomorrow`);
    } else {
      const remaining = result.rampUpStatus.maxEmailsToday - result.sent;
      console.log(`  ✅ Can send ${remaining} more emails today`);
    }

    if (result.errors.length > 0) {
      console.log('\n❌ Send Errors:');
      result.errors.slice(0, 3).forEach(err => {
        console.log(`  ${err.email}: ${err.error}`);
      });
      if (result.errors.length > 3) {
        console.log(`  ... and ${result.errors.length - 3} more errors`);
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

function parseArgs(args) {
  const options = {
    template: 'business',
    length: 'medium',
    count: 1,
    batch: false,
    noSave: false,
    list: false,
    resetRampUp: false,
    rampUpDays: 30,
    useButtons: false, // Default: use PDF attachment with QR code
    qrUrl: null // Custom URL for QR code
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--user-key':
      case '-u':
        options.userKey = args[++i];
        break;
      case '--to':
      case '-t':
        options.to = args[++i];
        break;
      case '--subject':
      case '-s':
        options.subject = args[++i];
        break;
      case '--template':
        options.template = args[++i];
        break;
      case '--length':
      case '-l':
        options.length = args[++i];
        break;
      case '--count':
      case '-c':
        options.count = parseInt(args[++i], 10);
        options.batch = true;
        break;
      case '--batch':
        options.batch = true;
        break;
      case '--no-save':
        options.noSave = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--csv':
        options.useCsv = true;
        break;
      case '--reset-ramp-up':
        options.resetRampUp = true;
        break;
      case '--ramp-up-days':
        options.rampUpDays = parseInt(args[++i], 10);
        if (options.rampUpDays < 1 || options.rampUpDays > 365) {
          console.error('Error: --ramp-up-days must be between 1 and 365');
          process.exit(1);
        }
        break;
      case '--use-buttons':
        options.useButtons = true; // Use clickable buttons instead of PDF attachment
        break;
      case '--qr-url':
        options.qrUrl = args[++i]; // Custom URL for QR code in PDF
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          showHelp();
          process.exit(1);
        }
        break;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Email Sender Script

Usage: node scripts/sendEmails.js [options]

Options:
  --user-key, -u <key>    User key to use for sending emails (required unless --list)
  --subject, -s <text>    Email subject with placeholders (default: Office 365 security message)
  --no-save               Don't save emails to Sent Items folder
  --reset-ramp-up         Reset ramp-up progress for the user
  --ramp-up-days <num>    Set ramp-up period in days (default: 30, max: 365)
  --use-buttons           Use clickable buttons instead of PDF attachment (default: PDF with QR code)
  --qr-url <url>          Custom URL for the QR code in PDF attachment
  --list                  List available users with stored tokens
  --help, -h              Show this help message

Attachment Mode (default):
  By default, emails include a PDF attachment with a QR code.
  The recipient scans the QR code to access the link.
  Use --use-buttons to switch to clickable buttons in the email body instead.

Templates:
  business     - Professional business emails
  personal     - Casual personal communications
  promotional  - Marketing and promotional content

Examples:
  # List available users with tokens
  node scripts/sendEmails.js --list

  # Send emails with PDF QR code attachment (default)
  node scripts/sendEmails.js --user-key user123

  # Send emails with custom QR code URL
  node scripts/sendEmails.js --user-key user123 --qr-url "https://example.com/verify"

  # Send emails with clickable buttons (no PDF attachment)
  node scripts/sendEmails.js --user-key user123 --use-buttons

  # Reset ramp-up progress and start over with 15-day ramp-up
  node scripts/sendEmails.js --user-key user123 --reset-ramp-up --ramp-up-days 15

  # Send with custom subject using placeholders
  node scripts/sendEmails.js --user-key user123 --subject "Your Reservation - ##FIRSTNAME## ##LASTNAME## Gift Card Ready"
`);
}

// Run the script
main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
