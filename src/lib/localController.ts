import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as mkdirp from 'mkdirp'
import { EventEmitter } from 'events'

import { config } from '../lib/config'
import { promisify } from './util'
import { showDirPicker } from './localMethods'

interface INewDirParams {
  dir: string,
  placeholder?: string,
  currentDirLabel?: string
}

/**
 * @class LocalController
 */
const LocalController = class LocalController extends EventEmitter {
  disposables: vscode.Disposable[]
  eventListeners: any
  
  constructor (disposables) {
    if (!disposables || !(disposables instanceof Array)) {
      throw new ReferenceError('An array for disposables is required')
    }

    super()
    this.disposables = disposables
    this.eventListeners = {}
    this.attachOnSaveListener()
    this.attachOnOpenListener()
  }

  async performStartupTasks () {
    /*
     * -- Startup logic --
     * This revolves around whether this is a placeholder / config file and
     * if there is a config file, whether it is valid.
     * 
     * - No placeholder or config: watch fs for both, when one is created run
     *   startup checks again
     * - Placeholder exists but no config: convert placeholder to config, run
     *   startup checks again
     * - Config exists: add onChange listener which checks validity of
     *   contents. If it is valid, emit the appropriate event. If it is invalid
     *   show an error.
     */
    if (!(await this.placeholderExists()) && !(await this.configFileExists())) {
      if (!this.eventListeners.created) {
        this.on('fileCreated', (file) => this.performStartupTasks())
        this.eventListeners.created = true
      }
    } else if (await this.placeholderExists()) {
      await this.convertPlaceholderIntoConfig()
      this.performStartupTasks()
    } else if (await this.configFileExists()) {
      if (!this.eventListeners.changed) {
        this.on('fileSaved', async (file) => {
          if (file.fileName === config.getConfigPath()) {
            if (await this.configIsValid()) {
              console.log('Got valid config JSON')
              this.emit('validConfigUpdate', await this.getConfigJSON())
            } else {
              console.log('Got invalid config JSON')
              this.emit('invalidConfigUpdate')
            }
          }
        })
        this.eventListeners.changed = true
      }
    }
  }

  /**
   * Listens to file save events in the current workspace and passes
   * the events back out under "fileSaved" events
   *
   */
  attachOnSaveListener () {
    if (!this.eventListeners.save) {
      this.disposables.push(
        vscode.workspace.onDidSaveTextDocument((textDocument) => {
          this.emit('fileSaved', textDocument)
        })    
      )
      this.eventListeners.save = true
    }
  }

  /**
   * Listens to file open events in the current workspace and passes
   * the events back out under "fileOpened" events
   *
   */
  attachOnOpenListener () {
    if (!this.eventListeners.open) {
      this.disposables.push(
        vscode.workspace.onDidOpenTextDocument((textDocument) => {
          this.emit('fileOpened', textDocument)
        })
      )
      this.eventListeners.open = true
    }
  }

  /**
   * Check if a file/folder exists
   *
   * @async
   * @param {string} path The path to the file
   */
  async fileExists (path: string) {
    try {
      return fs.existsSync(path)
    } catch (ex) {
      return false
    }
  }

  /**
   * Check if the placeholder file exists
   *
   * @async
   * @returns {boolean} Whether it exists
   */
  async placeholderExists () {
    const placeholderPath = config.getPlaceholderPath()
    return await this.fileExists(placeholderPath)
  }

  /**
   * Create a file which will be searched for when this extension activates.
   * If it is found, a blank config file will be created in its place & then
   * opened
   * 
   * @returns {boolean} The outcome 
   */
  async createPlaceholderFile (filePath?: string) {
    const placeholderPath = filePath
      ? path.join(filePath, config.placeholderFileName)
      : config.getPlaceholderPath()

    if ((filePath && await this.fileExists(placeholderPath)) ||
        (!filePath && await this.placeholderExists())) {
      console.error('Refusing to make additional placeholder file')
      return false
    }

    if (filePath || await this.createConfigDir()) {
      try {
        await promisify(fs.writeFile)(placeholderPath, '')
      } catch (ex) {
        console.error(`Unable to create placeholder file at "${placeholderPath}"`)
        console.error(ex)      
        return false
      }
    } else {
      console.error(`Unable to create config directory at "${config.getConfigDir()}"`)
    }

    return true
  }

  /**
   * Take a placeholder file and wipe it, replacing it with a config file
   *
   * @async
   * @returns {boolean} Whether the file was replaced
   */
  async convertPlaceholderIntoConfig () {
    console.log('Converting placeholder file')
    if (await this.placeholderExists()) {
      const placeholderPath = config.getPlaceholderPath()
      try {
        await promisify(fs.unlink)(placeholderPath)
      } catch (ex) {
        console.error(`Unable to remove placeholder file from "${placeholderPath}". Continuing anyway`)
        console.error(ex)
      }
    
      try {
        await this.createConfigFile()
      } catch (ex) {
        console.error(`Unable to create config file`)
        console.error(ex)
        return false
      }

      const configPath = config.getConfigPath()
      await this.openFile(configPath)      

      return true
    }

    return false
  }

  /**
   * Check if the config file exists
   *
   * @async
   * @returns {boolean} Whether it exists
   */
  async configFileExists () {
    const configPath = config.getConfigPath()
    return await this.fileExists(configPath)
  }

  /**
   * Get the config file's contents as a raw string
   *
   * @async
   * @returns {string|null} Either the string contents, or null on error
   */
  async getConfigFileContents () {
    const configPath = config.getConfigPath()

    let configString = null
    if (await this.configFileExists()) {
      try {
        const configFile = await vscode.workspace.openTextDocument(configPath)
        configString = configFile.getText()
      } catch (ex) {}
    }

    return configString
  }

  /**
   * Get the config file's contents as JSON
   *
   * @async
   * @returns {object|null} Either the configuration object, or null on error
   */
  async getConfigJSON () {
    const configString = await this.getConfigFileContents()
    if (!configString) {
      return null
    }

    let configJSON = null
    try {
      configJSON = JSON.parse(configString)
      if (configJSON.privateKey) {
        configJSON.privateKey = path.resolve(configJSON.privateKey)
      }
    } catch (ex) {
      console.error(ex)
    }

    return configJSON
  }

  /**
   * Check whether there is a present, valid config
   * 
   * @async
   * @param {any} [config] A config to override the one in the config file
   * @returns {boolean} Whether the config is valid
   */
  async configIsValid (config?: any) {
    config = config || await this.getConfigJSON()
    if (!config) {
      return false
    }

    const conforms = Boolean(
      typeof config === 'object' &&
      'connection' in config &&
      typeof config.connection === 'object' &&
      'host' in config.connection && config.connection.host &&
      'username' in config.connection && config.connection.username &&
      ('password' in config.connection || 'privateKey' in config.connection) &&
      (config.connection.password || config.connection.privateKey)
    )

    return conforms
  }

  /**
   * Create the .vscode directory in the current project's root
   *
   * @async
   * @returns {boolean} The outcome
   */
  async createConfigDir () {
    const configDir = config.getConfigDir()
    if (!(await this.fileExists(configDir))) {
      try {
        mkdirp(configDir)
      } catch (ex) {
        console.error(`Unable to create config dir at "${configDir}"`)
        console.error(ex)
        return false
      }
    } else {
      console.error(`Cannot create "${configDir}" as it already exists`)
    }

    return true
  }

  /**
   * Create a default config file
   *
   * @async
   * @returns {boolean} The outcome
   */
  async createConfigFile () {
    if (await this.createConfigDir()) {
      const configPath = config.getConfigPath()
      try {
        await promisify(fs.writeFile)(configPath, config.getDefaultConfigString())
      } catch (ex) {
        console.error(`Unable to create config file at "${configPath}"`)
        console.error(ex)
        return false
      }
    } else {
      return false
    }

    return true
  }

  /**
   * Get a full path to a folder which does not (yet) exist
   *
   * @async
   * @param {any} params Contains `dir`, `placeHolder` and `currentDirLabel`
   * @returns {null|string} Null on error, the path on success
   */
  async getNewDirectoryPath (params: INewDirParams = {dir: config.getRootDir()}) {
    params.placeholder = params.placeholder ||
      'Where would you like to create the project'
    params.currentDirLabel = params.currentDirLabel ||
      'create the project in this directory'

    // Get the path where the new folder will go
    let baseDir = null
    try {
      baseDir = await showDirPicker(params)
    } catch (ex) {
      console.error('Error showing directory picker')
      return new Error('Error showing directory picker')
    }
    if (!baseDir) {
      console.error(`No path selected by user for new dir`)
      return new Error('No path selected')
    }

    let folderName = null
    try {
      // Now get the new folder name from them
      folderName = await vscode.window
        .showInputBox({
          prompt: 'Enter the name of the new project',
          placeHolder: 'e.g. myApp'
        })
      if (!folderName) {
        console.error('Blank folder name received')
        throw new Error()
      }
    } catch (ex) {
      console.error('No folder name supplied')
      return new Error('No folder name supplied')
    }

    // Join the base path and new folder name
    const fullPath = path.join(baseDir, folderName)
    if (await this.fileExists(fullPath)) {
      return new Error(`File/folder "${fullPath}" already exists`)
    }

    return fullPath
  }

  /**
   * Open a file and show it to the user
   *
   * @async
   * @param {string} path 
   */
  async openFile (path: string) {
    try {
      const file = await vscode.workspace.openTextDocument(path)
      const document = await vscode.window.showTextDocument(file)
    } catch (ex) {
      console.error(`Unable to open/display config file`)
      console.error(ex)
    }
  }

  /**
   * Build a local directory structure of blank files
   *
   * @async
   * @param {any} fileTree 
   */
  async createLocalFileStructure (fileTree: any) {
    try {
      console.log('Creating local directory structure...')
      await this.traverseFileTree(fileTree, config.getRootDir())
    } catch (ex) {
      console.error('Unable to create local directory structure')
      console.error(ex)
      return false
    }

    return true
  }

  /**
   * Walk across a file tree, recursing for directories
   *
   * @async
   * @param {any} fileTree 
   * @param {string} base The dir to work relative to 
   */
  async traverseFileTree (fileTree: any, base) {
    for (let key in fileTree) {
      const absFilePath = base + key
      if (fileTree[key] === null) {
        // is a file
        if (!await this.fileExists(absFilePath)) {
          await this.makeBlankFile(absFilePath)
        }
      } else if (typeof fileTree[key] === 'object') {
        // is a folder
        await promisify(mkdirp)(absFilePath)
        await this.traverseFileTree(fileTree[key], absFilePath + '/')
      }
    }
  }

  /**
   * Create an empty file
   *
   * @async
   * @param {string} absolutePath The absolute path to the file to create
   * @returns 
   */
  async makeBlankFile (absolutePath: string) {
    return await promisify(fs.appendFile)(absolutePath, '')
  }
}

export {
  LocalController
}
