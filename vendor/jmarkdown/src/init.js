/* 
	Code for initialising a new JMarkdown project.

	If called for the first time in a folder *without* a .jmarkdown/ directory:
 	
 	1. Create the .jmarkdown/ directory
 	2. Create a config-template.json file inside that directory
 	3. [Optional] If the filename is specified, create a new file according to
 		jmarkdown-template.md in the directory, with the specified filename.
*/
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, configManager } from './config-manager.js';
import Mustache from 'mustache';

const file_template = `---
Title: {{title}}
Date: ${getCurrentDate()}
Author: {{Author}}
CSS: jmarkdown.css
Biblify activate: true
Bibliography: bibliography.bib
Bibliography style: harvard1
---

# Heading

`;

export function initialise(options, src_path = '') {
	// When we get here we know the options are valid.
	console.log('Initalising a new JMarkdown project');
	const local_jmarkdown_dir = path.resolve(process.cwd(), '.jmarkdown/');
	const local_jmarkdown_config = path.resolve(process.cwd(), '.jmarkdown/', 'config.json');

	try {
		// Check if .jmarkdown/ exists
		fs.accessSync(local_jmarkdown_dir);
	}
	catch (error) {
		console.log(`${local_jmarkdown_dir} does not exist - creating directory...`);
		fs.mkdirSync('.jmarkdown');
	}

	try {
		// Check if .jmarkdown/config.json exists
		fs.accessSync(local_jmarkdown_config);
	}
	catch (error) {
		// Check if .jmarkdown/config-template.json exists
		try {
			fs.accessSync(path.resolve(process.cwd(), '.jmarkdown/config-template.json'));
		}
		catch (error2) {
			// If config-template.json doesn't exist, create it.  This nested try/catch is
			// needed so that we don't attempt to re-create it every time if the user doesn't
			// bother creating a local config.json file
			fs.writeFileSync('.jmarkdown/config-template.json', JSON.stringify(DEFAULT_CONFIG, null, 4), { encoding: 'utf8' });
			console.log(`.jmarkdown/config-template.json created.`);
		}
	}

	if (options.file && fs.existsSync(options.file) == false) {
		console.log(`creating ${options.file} with title ${options.title}`);
		const file = Mustache.render(file_template, { title: options.title, Author: configManager.get("Author") });
		fs.writeFileSync(options.file, file, { encoding: 'utf8' });
	}

	if (options.makefile !== undefined) {
		createMakefileTemplate(options, src_path);
	}

	if (options.print !== undefined) {
		copyPrintUtilityFiles(options, src_path);
	}
}

function copyPrintUtilityFiles(options, src_path) {
	try {
		if (fs.existsSync(path.join(process.cwd(),'package.json'))) {
			console.log("I didn't create package.json because that file already exists!");
			console.log("If print.js is installed, make sure you install puppeteer and browser-sync before using.");
		}
		else {
			fs.copyFileSync(path.join(src_path, "package-print.json"), path.join(process.cwd(), "package.json"));
			console.log("Created package.json file for print.js");
		}

		if (fs.existsSync(path.join(process.cwd(), 'print.js'))) {
			console.log("I didn't install print.js because a file of that name already exists...");
		}
		else {
			fs.copyFileSync(path.join(src_path, "print.js"), path.join(process.cwd(), "print.js"));
			console.log("Installed print.js file for exporting jmarkdown to PDF");
			console.log("  ==> remember to install puppeteer and browser-sync by typing 'npm install'!");
		}
	}
	catch (e) {
		console.log("Something went wrong while attempting to install the jmarkdown print utility.  Here's the error:")
		console.log(e);
	}
}

function createMakefileTemplate(options, src_path) {
	const template = fs.readFileSync(path.join(src_path, "Makefile.mustache"), 'utf8');
	
	options['Markdown_File'] = options.file;

	// When this is true it means no optional key was specified, which usually means
	// we're creating the makefile for the first time.  But if the makefile exists and no
	// key was specified, pick the first three letters of the file name (or everything before the .md,
	// if the filename is shorter)
	const makefile_path = path.join(process.cwd(), "Makefile");

	if (options.makefile == true && fs.existsSync(makefile_path)) {
		const f = options.file;
		if (f.length > 3) {
			options['key'] = '-' + f.slice(0,3);
			options['key_uppercase'] = '-' + f.slice(0,3).toUpperCase();	
		}
		else {
			options['key'] = '-' + f.split('.')[0];
			options['key_uppercase'] = '-' + f.split('.')[0].toUpperCase();
		}
	}
	else if (options.makefile == true) {
		options['key'] = '';
		options['key_uppercase'] = '';
	}
	else {
		options['key'] = "-" + options.makefile;
		options['key_uppercase'] = "-" + options.makefile.toUpperCase();
	}

	if (fs.existsSync(makefile_path)) {
		// File exists, so hide the Chrome definition
		options['First_Time'] = false;
	}
	else {
		// File doesn't exist, so add the Chrome definition
		options['First_Time'] = true;
	}

	const output = Mustache.render(template, options);
	fs.appendFileSync(makefile_path, output);
}


function getCurrentDate() {
	const now = new Date();

	// Get day, month, and year
	const day = String(now.getDate()); // DD format with leading zero
	const monthNames = [
		'January', 'February', 'March', 'April', 'May', 'June', 
		'July', 'August', 'September', 'October', 'November', 'December'
	];
	const month = monthNames[now.getMonth()]; // Full month name
	const year = now.getFullYear(); // YYYY format

	// Combine into desired format
	return `${day} ${month} ${year}`;
}

export function showOptions() {
	console.log(JSON.stringify(DEFAULT_CONFIG, null, 4));
}
