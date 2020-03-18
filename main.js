const core = require("@actions/core")
const github = require("@actions/github")
const shell = require("shelljs")
const yaml = require("js-yaml")
const fs = require("fs")
const {Storage} = require('@google-cloud/storage')
const path = require("path")
const process = require("process")

const context = github.context

const branch = "gh-pages"
const platforms = {
  GITHUB_PAGES: "github_pages",
  GOOGLE_CLOUD: "google_cloud"
}
const platform = (core.getInput("platform") == platforms.GOOGLE_CLOUD) ? plaforms.GOOGLE_CLOUD : platforms.GITHUB_PAGES

// User defined input
const jazzyVersion = core.getInput("version")
const configFilePath = core.getInput("config")
const jazzyArgs = core.getInput("args")

// Github Pages
const token = core.getInput("personal_access_token")

const remote = `https://${token}@github.com/${context.repo.owner}/${context.repo.repo}.git`

// Google Cloud
const destinationFolder = core.getInput("destination_folder") || ""
const googleCloudBucket = core.getInput("bucket_name")
const googleCloudCredentials = core.getInput("google_cloud_credentials")

const generateJazzyInstallCommand = () => {
  let gemInstall = "sudo gem install jazzy"

  if (jazzyVersion) {
    gemInstall + ` -v ${jazzyVersion}`
  }

  return gemInstall
}

const generateJazzyArguments = () => {
  if (configFilePath) {
    return `jazzy --config ${configFilePath}`
  }

  if (jazzyArgs) {
    return `jazzy ${jazzyArgs}`
  }

  return "jazzy"
}

const sliceDocumentsFromJazzyArgs = (outputArg) => {
  const startIndexOfDocsDir = jazzyArgs.indexOf(outputArg) + outputArg.length + 1
  const endIndexOfDocsDir = jazzyArgs.indexOf(" ", startIndexOfDocsDir)

  if (endIndexOfDocsDir != -1) {
    return jazzyArgs.slice(startIndexOfDocsDir, endIndexOfDocsDir)
  } else {
    return jazzyArgs.slice(startIndexOfDocsDir)
  }
}

const getDocumentationFolder = () => {
  if (configFilePath) {
    let config
    const fileExt = configFilePath.split(".").pop().toLowerCase()

    if (fileExt === "yml" || fileExt === "yaml") {
      config = yaml.safeLoad(fs.readFileSync(configFilePath, "utf8"))
    } else if (fileExt === "json") {
      const rawData = fs.readFileSync(configFilePath)
      config = JSON.parse(rawData)
    }

    if (config.output) {
      return config.output
    }
  }

  if (jazzyArgs) {
    // --output needs to be checked first, because --output includes -o
    if (jazzyArgs.includes("--output")) {
      return sliceDocumentsFromJazzyArgs("--output")
    }

    if (jazzyArgs.includes("-o")) {
      return sliceDocumentsFromJazzyArgs("-o")
    }
  }

  return "docs"
}

const generateAndDeploy = () => {
  shell.exec(generateJazzyInstallCommand())
  shell.exec(generateJazzyArguments())
  shell.exec("mkdir ../.docs")
  shell.cp("-r", `${getDocumentationFolder()}/*`, "../.docs/")

  shell.cd("../.docs")

  console.log(`deploying to ${platform}`)
  if (platform == platforms.GOOGLE_CLOUD) {
    deployToGoogleCloud()
  } else {
    deployToGitHubPages()
  }

  shell.cd(process.env.GITHUB_WORKSPACE)
}

const deployToGitHubPages = () => {

  shell.exec("git init")
  shell.exec(`git config user.name ${context.actor}`)
  shell.exec(`git config user.email ${context.actor}@users.noreply.github.com`)
  shell.exec("git add .")
  shell.exec("git commit -m 'Deploying Updated Jazzy Docs'")
  shell.exec(`git push --force ${remote} master:${branch}`)
  
}

const deployToGoogleCloud = () => {
  const files = getFilesInFolder(".", ["undocumented.json"])
  const fullPath = path.resolve(".")
  uploadFilesToGoogleCloud(files, fullPath, googleCloudBucket)
}

const getFilesInFolder = (dir, ignore, filelist) => {
  let files = fs.readdirSync(dir)
  filelist = filelist || []
  files.forEach(function(file) {
    if (fs.statSync(dir + '/' + file).isDirectory()) {
      filelist = getFilesInFolder(dir + '/' + file, ignore, filelist)
    }
    else {
      if (!ignore.contains(file)) {
        filelist.push(dir + '/' + file)
      }
    }
  })
  return filelist
}

async function uploadFilesToGoogleCloud(files, fullPath, bucketName) {
  let errors = []

  const credsFile = path.resolve(fullPath, "gc.json")
  try {  
    fs.writeFileSync(credsFile, googleCloudCredentials, )
  } catch (err) {
    core.setFailed(err)
  }
  
  const storage = new Storage({ keyFilename: credsFile })

  for( var i=0; i < files.length; i++) {
    const filepath = files[i]
    const source = path.resolve(fullPath, filepath)
    const destination = destinationFolder + '/' + path.relative(".", filepath)
    console.log(`GC > uploading ${source} to ${destination}`)
    try {
      await storage.bucket(bucketName).upload(source, {
        gzip: true,
        destination: destination,
        metadata: {
          cacheControl: 'no-cache',
        },
      })
    } catch (err) {
      errors.push(err)
    }
  }
  if (errors > 0) {
    // fail so we can re-run
    core.setFailed(`There were ${errors.length} errors uploading to Google Cloud:`, errors)
  }
}

try {
  generateAndDeploy()
} catch (error) {
  core.setFailed(error.message)
}

