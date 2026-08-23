const puppeteer = require('puppeteer');
const browserSync = require('browser-sync');
const path = require('path');

async function htmlToPdf(htmlFilePath, browser, serverPort = 3100) {
  const serverDir = path.dirname(path.resolve(htmlFilePath));
  const fileName = path.basename(htmlFilePath);
  const outputPath = fileName.replace('.html', ".pdf");
  
  let bs;
  
  try {
    // Start local server for this file
    bs = browserSync.create();
    
    console.log(`Starting server for ${fileName} in: ${serverDir}`);
    
    await new Promise((resolve, reject) => {
      bs.init({
        server: { baseDir: serverDir },
        port: serverPort,
        open: false,
        logLevel: 'silent',
        notify: false
      }, (err) => err ? reject(err) : resolve());
    });
    
    console.log(`Server running at http://localhost:${serverPort}`);
    
    // Create a new page for this conversion
    const page = await browser.newPage();
    
    // Log errors (but ignore favicon 404s)
    page.on('response', response => {
      if (response.status() >= 400 && !response.url().includes('favicon.ico')) {
        console.log(`Failed to load: ${response.url()} (${response.status()})`);
      }
    });
    
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    
    // Load the page and wait for all resources
    const url = `http://localhost:${serverPort}/${fileName}`;
    console.log(`Loading page: ${url}`);
    
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Generate A4 PDF
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        right: '20mm', 
        bottom: '20mm',
        left: '20mm'
      },
      displayHeaderFooter: false,
      preferCSSPageSize: false
    });
    
    console.log(`PDF generated: ${outputPath}`);
    
    // Close the page
    await page.close();
    
  } catch (error) {
    console.error(`Error processing ${fileName}:`, error.message);
    throw error;
  } finally {
    // Clean up server
    if (bs) bs.exit();
  }
}

async function convertMultipleFiles(htmlFiles, startPort = 3100) {
  let browser;
  
  try {
    // Launch browser once for all conversions
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    console.log(`Converting ${htmlFiles.length} HTML file(s) to PDF...`);
    
    // Process each file sequentially
    for (let i = 0; i < htmlFiles.length; i++) {
      const htmlFile = htmlFiles[i];
      const port = startPort + i; // Use different port for each server
      
      console.log(`\n--- Processing file ${i + 1}/${htmlFiles.length}: ${htmlFile} ---`);
      
      try {
        await htmlToPdf(htmlFile, browser, port);
      } catch (error) {
        console.error(`Failed to convert ${htmlFile}:`, error.message);
        // Continue with other files even if one fails
      }
      
      // Small delay between files to ensure servers shut down cleanly
      if (i < htmlFiles.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log('\n--- All conversions completed ---');
    
  } catch (error) {
    console.error('Error during batch conversion:', error.message);
    throw error;
  } finally {
    // Clean up browser
    if (browser) {
      console.log('Closing browser...');
      await browser.close();
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: node script.js <html-file1> [html-file2] [html-file3] ... [--port=start-port]');
    console.log('Examples:');
    console.log('  node script.js page.html');
    console.log('  node script.js page1.html page2.html page3.html');
    console.log('  node script.js *.html --port=3200');
    process.exit(1);
  }
  
  let htmlFiles = [];
  let startPort = 3100;
  
  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      startPort = parseInt(arg.split('=')[1]) || 3100;
    } else if (arg.endsWith('.html')) {
      htmlFiles.push(arg);
    } else {
      console.warn(`Ignoring non-HTML file: ${arg}`);
    }
  }
  
  if (htmlFiles.length === 0) {
    console.error('No HTML files specified!');
    process.exit(1);
  }
  
  return { htmlFiles, startPort };
}

async function main() {
  const { htmlFiles, startPort } = parseArgs();
  
  try {
    await convertMultipleFiles(htmlFiles, startPort);
  } catch (error) {
    console.error('Failed to convert HTML files to PDF:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { htmlToPdf, convertMultipleFiles };