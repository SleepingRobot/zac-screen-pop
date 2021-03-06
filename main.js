const unhandled = require('electron-unhandled')
unhandled()
const { app, BrowserWindow, ipcMain, Menu, Tray } = require('electron')
const fs = require('fs')
const crypto = require('crypto')
const path = require('path')
const keytar = require('keytar')
const isPrimaryInstance = app.requestSingleInstanceLock()
const keytarService = 'teleworks-screenpop'
let tray = null
let screenpopWindow = null
let historyWindow = null
let settingsWindow = null
let authWindow = null
let openWindows = ['screenpop']
let auth = {
  redtail: {
    name: '',
    id: '',
    key: '',
  }
}
let settings = {
  lookups: [],
  fieldsToDisplay: ["redtail-status", "redtail-source", "redtail-category"]
}
let imgPaths = {}

if(isPrimaryInstance) {
  // If this is the primary instance and a secondary instance is opened
  // re-focus our primary window if it exists, and process the new CLI args
  app.on('second-instance', async (event, argv, workingDirectory) => {
    if (screenpopWindow) {
      await parseCommandLineArgs(argv)
      if(!openWindows.includes('screenpop')) openWindows.push('screenpop')
      showApp()
      attemptPendingLookups()
    }
  })
} else {
  // ... otherwise, if this is the secondary instance, self-terminate
  app.exit()
}


// Disable HW acceleration and add delay to app ready to account for transparency bug
// https://github.com/electron/electron/issues/16809
app.disableHardwareAcceleration()
app.on('ready', () => setTimeout(onAppReady, 500));


async function onAppReady() {
  initTrayIcon()
  resolveImgPaths()
  initWindows()
  //await clearAuth('Redtail')
  await checkKeychainForAuth()
  await loadSettings()
  await parseCommandLineArgs()
  attemptPendingLookups()
}

function initTrayIcon() {
  tray = new Tray(`${__dirname}/build/icon.ico`)
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Teleworks MiniPop', type: 'normal', enabled: false},
    { type: 'separator'},
    { label: 'Show', type: 'normal', click() { showApp() } },
    { label: 'Exit', type: 'normal', click() { app.exit() } }
  ])
  tray.setToolTip('Teleworks MiniPop')
  tray.setContextMenu(contextMenu)
}

function resolveImgPaths() {
  imgPaths.app = path.join(process.resourcesPath, 'extraResources', 'icon.png');
  imgPaths.history = path.join(process.resourcesPath, 'extraResources', 'history.svg');
  imgPaths.settings = path.join(process.resourcesPath, 'extraResources', 'settings.svg');
  imgPaths.close = path.join(process.resourcesPath, 'extraResources', 'close.svg');
  imgPaths.redtailSmall = path.join(process.resourcesPath, 'extraResources', 'redtail-icon-small.png');
  imgPaths.redtailFull = path.join(process.resourcesPath, 'extraResources', 'redtail-icon-full.png');
}

function initWindows() {
  const windowOptions = {
    transparent: true, 
    frame: false,
    minWidth: 400,
    minHeight: 300,
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false,
      sandbox: true,
      affinity: 'minipopUI',
      preload: `${__dirname}/preload.js`
    }
  }
  const closeToTray = (e) => {
    e.preventDefault()
    hideApp()
  }
  screenpopWindow = new BrowserWindow({...windowOptions, width:400, height:300})
  screenpopWindow.removeMenu()
  screenpopWindow.loadFile('screenpop.html')
  screenpopWindow.on('close', closeToTray)
  screenpopWindow.webContents.once('did-finish-load', () => {
    screenpopWindow.webContents.send('image-paths', imgPaths)
  })
  //screenpopWindow.webContents.openDevTools()
  historyWindow = new BrowserWindow({...windowOptions, width:400, height:600, show:false, parent:screenpopWindow})
  historyWindow.removeMenu()
  historyWindow.loadFile('history.html')
  historyWindow.hide()
  historyWindow.webContents.once('did-finish-load', () => {
    historyWindow.webContents.send('image-paths', imgPaths)
  })
  //historyWindow.webContents.openDevTools()
  settingsWindow = new BrowserWindow({...windowOptions, width:400, height:600, show:false, parent:screenpopWindow})
  settingsWindow.removeMenu()
  settingsWindow.loadFile('settings.html')
  settingsWindow.hide()
  settingsWindow.webContents.once('did-finish-load', () => {
    settingsWindow.webContents.send('image-paths', imgPaths)
    settingsWindow.webContents.send('settings-data', auth, settings.fieldsToDisplay)
  })
  //settingsWindow.webContents.openDevTools()
  authWindow = new BrowserWindow({...windowOptions, width:400, height:300, maxWidth:400, maxHeight:300, resizable:false, show:false, parent:screenpopWindow})
  authWindow.removeMenu()
  authWindow.loadFile('auth.html')
  authWindow.on('close', closeToTray)
  authWindow.webContents.once('did-finish-load', () => {
    authWindow.webContents.send('image-paths', imgPaths)
  })
  //authWindow.webContents.openDevTools()
}

function hideApp() {
  screenpopWindow.hide()
  authWindow.hide()
  historyWindow.hide()
  settingsWindow.hide()
}

function showApp() {
  if(openWindows.includes('screenpop')) screenpopWindow.show()
  if(openWindows.includes('auth')) authWindow.show()
  if(openWindows.includes('history')) historyWindow.show()
  if(openWindows.includes('settings')) settingsWindow.show()
}

// Return existing Key and IV if present in OS User's keychain, otherwise generate, store, and return new ones
async function getEncryptionSecrets() {
  k = await keytar.getPassword(keytarService, 'encryption-key')
  i = await keytar.getPassword(keytarService, 'encryption-iv')
  if(k && i) {
    k = Buffer.from(k, 'hex')
    i = Buffer.from(i, 'hex')
    return {key: k, iv: i}
  } else {
    let newKey = crypto.randomBytes(32)
    let newIv = crypto.randomBytes(16)
    keytar.setPassword(keytarService, 'encryption-key', newKey.toString('hex'))
    keytar.setPassword(keytarService, 'encryption-iv', newIv.toString('hex'))
    return {key: newKey, iv: newIv}
  }
}

// Reads settings from encrypted file on disk, if present
// TODO: Add better error handling
async function loadSettings() {
  const settingsFile = path.resolve(process.env.PORTABLE_EXECUTABLE_DIR, 'minipop.sec')
  const secrets = await getEncryptionSecrets()
  const decipher = crypto.createDecipheriv('aes-256-cbc', secrets?.key, secrets?.iv)
  try {
    const input = fs.readFileSync(settingsFile)
    const output = Buffer.concat([decipher.update(input), decipher.final()])
    if(output){
      settings = JSON.parse(output)
      if (!settingsWindow.webContents.isLoading()) {
        settingsWindow.webContents.send('settings-data', auth, settings.fieldsToDisplay)
      } else {
        settingsWindow.webContents.once('did-finish-load', () => {
          settingsWindow.webContents.send('settings-data', auth, settings.fieldsToDisplay)
        })
      }
    }
  } catch (err) {
    logErr('Error reading lookup history from disk: ')
    logErr(err)
  }
}

// Saves settings to encrypted file on disk
// TODO: Add better error handling
async function saveSettings() {
  const settingsFile = path.resolve(process.env.PORTABLE_EXECUTABLE_DIR, 'minipop.sec')
  console.log(settingsFile)
  const secrets = await getEncryptionSecrets()
  const cipher = crypto.createCipheriv('aes-256-cbc', secrets?.key, secrets?.iv)
  const output = Buffer.concat([cipher.update(JSON.stringify(settings)), cipher.final()])
  try {
    fs.writeFileSync(settingsFile, output)
  } catch (err) {
    logErr('Error writing settings to disk: ')
    logErr(err)
  }
}


// If passed an argument array from secondary instance, process arguments from it
// otherwise, if primary instance, process arguments from app.commandLine
async function parseCommandLineArgs(argv = null){
  let redtailLookupNumber = ''
  
  if(argv){
    redtailLookupNumber = getCommandLineValue(argv, 'redtail-phone')
  } else {
    redtailLookupNumber = app.commandLine.getSwitchValue('redtail-phone')
  }

  // If passed a redtail number, push it to lookups with pending status and update lookup history on disk
  if(redtailLookupNumber) {
    settings.lookups.unshift(new lookup(Date.now(), 'Redtail', 'Phone', redtailLookupNumber, 'Pending', '', []))
    await saveSettings()
  }
}

function getCommandLineValue(argv, name) {
  let arg = argv.find(a => a.toLowerCase().startsWith('--' + name + '='))
  if(arg) {
    return arg.split('=')[1]
  } else {
    return ''
  }
}

// Attempts to resolve any pending lookups, then refreshes Screenpop and History data
async function attemptPendingLookups() {
  // Abort if there's no lookups to check
  if(settings.lookups.length < 1){
    logErr("Aborting 'attemptPendingLookups() as lookups array is empty")
    return
  }

  // Otherwise attempt to complete any pending lookups
  const pending = settings.lookups.filter(l => l?.status === 'Pending')
  if(pending.length > 0){
    for (var lookup of pending) {
      if(lookup?.crm === 'Redtail' && lookup?.type === 'Phone' && lookup?.input) {
        lookupRedtailPhone(lookup)
      }
    }
  }

  // Ensure file on disk is updated with latest results
  await saveSettings()

  // Refresh Screenpop and History windows with latest lookup data
  if(screenpopWindow && !screenpopWindow.webContents.isLoading() && settings.lookups.length > 0){
    screenpopWindow.webContents.send('screenpop-data', settings.lookups[0], settings.fieldsToDisplay)
  }
  if(historyWindow && !historyWindow.webContents.isLoading()) {
    historyWindow.webContents.send('history-data', settings.lookups, settings.fieldsToDisplay)
  }
}

function lookupRedtailPhone(lookup) {
  // If missing input or timestamp values, reject the lookup
  // TODO: decide best way to handle this going forward
  if(!lookup?.input || !lookup?.timestamp) {
    logErr('lookup aborted, missing input and/or timestamp:')
    logErr(lookup)
  }

  let i = settings.lookups.findIndex(x => x.timestamp == lookup.timestamp)
  if (i < 0) {
    // TODO: Decide best way to handle this scenario, as well. Just add error to log file?
    logErr('Unable to find lookup entry used in Redtail Phone Lookup in lookups array')
    logErr('---lookup:')
    logErr(lookup)
    logErr('---lookups:')
    logErr(settings.lookups)
    return
  }

  // If missing Redtail auth key, display credential input modal
  if(!auth.redtail.key) {
    openAuthModal('Redtail', 'Enter Redtail credentials to lookup contact.')
    return
  }

  // Parse number to format compatible with Redtail API
  const parsedNumber = parseNumber(lookup.input)

  // Prepare HTTP request to Redtail CRM API
  const { net } = require('electron')
  const request = net.request({
    method: 'GET',
    protocol: 'https:',
    hostname: 'smf.crm3.redtailtechnology.com',
    port: 443,
    path: '/api/public/v1/contacts/search?phone_number=' + parsedNumber 
  })
  request.setHeader('Authorization', 'Userkeyauth ' + auth.redtail.key)
  request.setHeader('include', 'addresses,phones,emails,urls')
  request.setHeader('Content-Type', 'application/json')

  // Process HTTP response from Redtail CRM API
  // TODO: add error handling
  request.on('response', (response) => {
    response.on('data', (d) => {
      const resp = JSON.parse(d)
      let matchCount = resp?.contacts?.length
      if (matchCount > 0) {
        settings.lookups[i].status = 'Success'
        settings.lookups[i].details = `Redtail returned ${matchCount} contacts matching phone number`
        for (var contact of resp.contacts) {
          settings.lookups[i].results.push(contact)
        }
      } else {
        settings.lookups[i].status = 'Success'
        settings.lookups[i].details = `Redtail returned 0 contacts matching phone number`
      }
      attemptPendingLookups()
    })
  })
  request.end()
}

// Strips '+1' and all non-digit characters from number, if present
function parseNumber (n) {
  return n.replace('+1','').replace(/\D/g,'')
}



function openAuthModal(crm, message = null) {
  // If History or Settings are open, close them
  
  openWindows = openWindows.filter(e => e !== 'settings')
  openWindows = openWindows.filter(e => e !== 'history')
  if (!settingsWindow.webContents.isLoading()) settingsWindow.hide()
  if (!historyWindow.webContents.isLoading()) historyWindow.hide()


  if (!message) {
    message = `Enter ${crm} Account Credentials.`
  }
  
  const authData = {crm: crm, message: message }

  if (!authWindow.webContents.isLoading()) {
    sendAuthModalData(authData)
  } else {
    authWindow.once('ready-to-show', () => {
      sendAuthModalData(authData)
    })
  }
}

function sendAuthModalData(authData){
  authWindow.webContents.send('auth-data', authData)
  authWindow.show()
  if(!openWindows.includes('auth')) openWindows.push('auth')
  screenpopWindow.hide()
  openWindows = openWindows.filter(e => e !== 'screenpop')
}

ipcMain.on('auth-submission', async (event, authData) => {
  // When auth input is submitted, close auth window and re-display screenpop
  screenpopWindow.show()
  if(!openWindows.includes('screenpop')) openWindows.push('screenpop')
  authWindow.hide()
  openWindows = openWindows.filter(e => e !== 'auth')

  // Then clear old auth settings...
  await clearAuth(authData.crm)

  // ...and validate new auth credentials
  if (authData?.crm === 'Redtail') {
    authenticateRedtail(authData)
  }
})

// logout of CRM via settings window
ipcMain.on('crm-logout', async (event, crm) => {
  await clearAuth(crm)
  if (!settingsWindow.webContents.isLoading()) {
    settingsWindow.webContents.send('settings-data', auth, settings.fieldsToDisplay)
  } else {
    settingsWindow.webContents.once('did-finish-load', () => {
      settingsWindow.webContents.send('settings-data', auth, settings.fieldsToDisplay)
    })
  }
})

// login to CRM via settings window
ipcMain.on('crm-login', async (event, authData) => {
  // Clear old auth settings
  await clearAuth(authData.crm)

  // ... and validate new auth credentials
  if (authData?.crm === 'Redtail') {
    authenticateRedtail(authData)
  }
})


ipcMain.on('toggle-displayfield', async (event, fieldData) => {
  // return if input is missing
  if(!fieldData?.input) return

  if(fieldData?.action === "add" && !settings.fieldsToDisplay.includes(fieldData.input)) {
    settings.fieldsToDisplay.push(fieldData.input)
  } else if (fieldData?.action === "remove") {
    settings.fieldsToDisplay = settings.fieldsToDisplay.filter(e => e !== fieldData.input)
  }

  // save changes to disk
  saveSettings()

   // Refresh Screenpop and History windows with latest display field data
  if(screenpopWindow && !screenpopWindow.webContents.isLoading() && settings.lookups.length > 0){
    screenpopWindow.webContents.send('screenpop-data', settings.lookups[0], settings.fieldsToDisplay)
  }
  if(historyWindow && !historyWindow.webContents.isLoading()) {
    historyWindow.webContents.send('history-data', settings.lookups, settings.fieldsToDisplay)
  }
})

ipcMain.on('toggle-history', async (event) => {
  if(openWindows.includes('history')){
    openWindows = openWindows.filter(e => e !== 'history')
    historyWindow.hide()
  } else {
    openWindows.push('history')
    historyWindow.show()
  }
})

ipcMain.on('toggle-settings', async (event) => {
  if(openWindows.includes('settings')){
    openWindows = openWindows.filter(e => e !== 'settings')
    settingsWindow.hide()
  } else {
    openWindows.push('settings')
    settingsWindow.show()
  }
})

ipcMain.on('hide-app', async (event) => {
  hideApp()
})

async function clearAuth(crm) {
  if (crm === 'Redtail') {
    auth.redtail.name = ''
    auth.redtail.id = ''
    auth.redtail.key = ''
    auth.redtail.msg = ''
    await keytar.deletePassword(keytarService, 'redtail-username')
    await keytar.deletePassword(keytarService, 'redtail-userid')
    await keytar.deletePassword(keytarService, 'redtail-userkey')
  }
}

// Since Redtail authentication endpoint only returns a user's name value when using Userkeyauth and not Basic auth...
// if this function successfully auths via Basic it will then recursively re-call itself with returned
// UserKey so that we can properly capture the user's name
function authenticateRedtail(authData, UserkeyToken = '') {

  // Prepare Basic auth header value if we were not passed a UserKey
  let basicToken = ''
  if(!UserkeyToken){
    const unencodedAuth = authData?.apiKey + ":" + authData?.username + ":" + authData?.password
    basicToken = Buffer.from(unencodedAuth).toString('base64')
  }

  // Prepare HTTP request to Redtail CRM API
  // TODO: Update this to Redtail TWAPI API if they ever start returning full user details...
  const { net } = require('electron')
  const request = net.request({
    method: 'GET',
    protocol: 'https:',
    hostname: 'api2.redtailtechnology.com',
    port: 443,
    path: '/crm/v1/rest/authentication'
  })
  request.setHeader('Content-Type', 'application/json')
  // Set appropriate auth header depending on whether we are using Basic or UserKey
  if(!UserkeyToken) {
    request.setHeader('Authorization', 'Basic ' + basicToken)
  } else {
    request.setHeader('Authorization', 'Userkeyauth ' + UserkeyToken)
  }

  // Process HTTP response from Redtail CRM API
  request.on('response', (response) => {
    if (response?.statusCode == 200) {
      response.on('data', (d) => {
        const resp = JSON.parse(d)
        if (resp?.APIKey && resp?.UserKey) {
          // If response indicates success, encode returned API UserKey
          const unencodedKey = resp?.APIKey + ":" + resp?.UserKey
          const encodedUserKey = Buffer.from(unencodedKey).toString('base64')

          // If we authenticated with Basic auth, returned name value will be null
          // so recursively re-call this function using returned UserKey
          if(!UserkeyToken) {
            authenticateRedtail(authData, encodedUserKey)
          } else {
            // otherwise, update auth settings in memory and store in OS User's keychain
            auth.redtail.msg = ''
            if (resp?.Name) {
              auth.redtail.name = resp.Name
              keytar.setPassword(keytarService, 'redtail-username', resp.Name)
            }
            if (resp?.UserID) {
              auth.redtail.id = resp.UserID.toString()
              keytar.setPassword(keytarService, 'redtail-userid', resp.UserID.toString())
            }
            if (encodedUserKey) {
              auth.redtail.key = encodedUserKey
              keytar.setPassword(keytarService, 'redtail-userkey', encodedUserKey)
            }
            // finally, attempt to resolve any pending lookups and refresh Screenpop + History + Settings windows
            if (!settingsWindow.webContents.isLoading()) {
              settingsWindow.webContents.send('settings-data', auth, settings.fieldsToDisplay)
            } else {
              settingsWindow.webContents.once('did-finish-load', () => {
                settingsWindow.webContents.send('settings-data', auth, settings.fieldsToDisplay)
              })
            }
            attemptPendingLookups()
          }
        }
      })
    } else if(response?.statusCode >= 400 && response?.statusCode < 500) {
      clearAuth("Redtail")
      auth.redtail.msg = `Credentials rejected by Redtail (HTTP ERR ${response.statusCode.toString()}). Please try again.`
      if(authData?.inputMethod == "modal"){
        openAuthModal('Redtail', `Credentials rejected by Redtail (HTTP ERR ${response.statusCode.toString()}). Please try again.`)
      } else if(authData?.inputMethod == "settings") {
        settingsWindow.webContents.send('settings-data', auth, settings.fieldsToDisplay)
      }
    } else {
      clearAuth("Redtail")
      auth.redtail.msg = `Error validating credentials (HTTP ERR ${response.statusCode.toString()}). Please try again.`
      if(authData?.inputMethod == "modal"){
        openAuthModal('Redtail', `Error validating credentials (HTTP ERR ${response.statusCode.toString()}). Please try again.`)
      } else if(authData?.inputMethod == "settings") {
        settingsWindow.webContents.send('settings-data', auth, settings.fieldsToDisplay)
      }
    }
  })
  request.end()
}

// If any CRM auth settings have been stored in OS User's Keychain, load them into memory
async function checkKeychainForAuth() {
  auth.redtail.name = await keytar.getPassword(keytarService, 'redtail-username')
  auth.redtail.id = await keytar.getPassword(keytarService, 'redtail-userid')
  auth.redtail.key = await keytar.getPassword(keytarService, 'redtail-userkey')
}

function logErr(err){
  console.error(err)
}


class lookup {
  constructor(timestamp, crm, type, input, status, details, results) {
    this.timestamp = timestamp
    this.crm = crm
    this.type = type
    this.input = input
    this.status = status
    this.details = details
    this.results = results
  }
}