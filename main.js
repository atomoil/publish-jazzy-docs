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

// User defined input
const jazzyVersion = core.getInput("version")
const configFilePath = core.getInput("config")
const jazzyArgs = core.getInput("args")

// Github Pages
const token = core.getInput("personal_access_token")

const remote = `https://${token}@github.com/${context.repo.owner}/${context.repo.repo}.git`

// Google Cloud Upload
// @TODO: validate / default this better
const platform = core.getInput("platform") || "githubpages"
const destinationFolder = core.getInput("destination_folder") || ""
const googleCloudBucket = "maisonkit-docs.lvmhda.com" //core.getInput("bucket_name")
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

const deployToGitHubPages = () => {

  shell.exec("git init")
  shell.exec(`git config user.name ${context.actor}`)
  shell.exec(`git config user.email ${context.actor}@users.noreply.github.com`)
  shell.exec("git add .")
  shell.exec("git commit -m 'Deploying Updated Jazzy Docs'")
  shell.exec(`git push --force ${remote} master:${branch}`)
  
}

const deployToGoogleCloud = () => {
  const files = getFilesInFolder(".")
  const fullPath = path.resolve(".")
  uploadFiles(files, fullPath, googleCloudBucket)
}

const getFilesInFolder = (dir, filelist) => {
  // List all files in a directory in Node.js recursively in a synchronous fashion
  let files = fs.readdirSync(dir)
  filelist = filelist || []
  files.forEach(function(file) {
    if (fs.statSync(dir + '/' + file).isDirectory()) {
      filelist = getFilesInFolder(dir + '/' + file, filelist)
    }
    else {
      filelist.push(dir + '/' + file)
    }
  })
  return filelist
}

async function uploadFiles(files, fullPath, bucketName) {
  let errors = 0

  try {
    const credsFile = path.resolve(fullPath, "gc.json")
    fs.writeFileSync(credsFile, googleCloudCredentials, )
  } catch (err) {
    console.error(err)
    process.exit()
  }
  
  const storage = new Storage({ keyFilename: credsFile })

  for( var i=0; i < files.length; i++) {
    const filepath = files[i]
    // Uploads a local file to the bucket
    const source = path.resolve(fullPath, filepath)
    const destination = destinationFolder + '/' + path.relative(".", filepath)
    console.log(`GC > uploading ${source} to ${destination}`)
    try {
      await storage.bucket(bucketName).upload(source, {
        // Support for HTTP requests made with `Accept-Encoding: gzip`
        gzip: true,
        // By setting the option `destination`, you can change the name of the
        // object you are uploading to a bucket.
        destination: destination,
        metadata: {
          // Enable long-lived HTTP caching headers
          // Use only if the contents of the file will never change
          // (If the contents will change, use cacheControl: 'no-cache')
          cacheControl: 'public, max-age=31536000',
        },
      })
      console.log(`GC > finished uploading ${destination}`)
    } catch (err) {
      console.log(`GC > error uploading ${source} > ${err}`)
      errors += 1
    }
  }
  console.log(`GC > finished with ${errors} errors`)
  if (errors > 0) {
    // fail so we can re-run
    process.exit()
  }
}

const generateAndDeploy = () => {
  shell.exec(generateJazzyInstallCommand())
  shell.exec(generateJazzyArguments())
  shell.exec("mkdir ../.docs")
  shell.cp("-r", `${getDocumentationFolder()}/*`, "../.docs/")

  shell.cd("../.docs")

  console.log(`deploying to ${platform}`)
  if (platform == "githubpages") {
    deployToGitHubPages()
  } else if (platform == "googlecloud") {
    deployToGoogleCloud()
  }

  shell.cd(process.env.GITHUB_WORKSPACE)
}

try {
  generateAndDeploy()
} catch (error) {
  core.setFailed(error.message)
}

