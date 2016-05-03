var fs = require('fs');
var readline = require('readline');
var google = require('googleapis');
var OAuth2 = google.auth.OAuth2;
var path = require('path');
var crypto = require('crypto');
var util = require('util');
const FOLDER_MIME = "application/vnd.google-apps.folder";

function DriveInteractions() {
    const CREDENTIALS_FILE = "client_secret.json";
    const AUTH_FILE = "auth.json";


    var drive;

    /*/ auth */
    function loadCredentials(callback) {
        fs.readFile(CREDENTIALS_FILE, function (err, content) {
            if (err) { console.log('File', CREDENTIALS_FILE, 'not found in the current folder (', __dirname, '). Download it from your google console'); return; }

            var clientSecret = JSON.parse(content);
            var keys = clientSecret.web || clientSecret.installed;
            var oauth2Client = new OAuth2(keys.client_id, keys.client_secret, keys.redirect_uris[0]);

            // inititializes the google drive api 
            drive = google.drive({ version: 'v2', auth: oauth2Client });

            fs.readFile(AUTH_FILE, function (err, content) {
                if (err)
                    fetchGoogleAuthorizationTokens(oauth2Client);

                else {
                    oauth2Client.credentials = JSON.parse(content);
                    callback();
                }
            });
        });
    }

    function fetchGoogleAuthorizationTokens(oauth2Client) {
        var authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive']
        });

        console.log('Authorize by visiting the url below:\n\n', authUrl, '\n\n');
        var rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question('Enter the code here: ', function (code) {
            rl.close();
            oauth2Client.getToken(code, function (err, token) {
                if (err) { console.log('Error while trying to retrieve access token', err); return; }

                if (!token.hasOwnProperty('refresh_token'))
                    console.log('refresh_token not received, app will not be able to refresh the access_token');

                fs.writeFile(AUTH_FILE, JSON.stringify(token));
            });
        });
    }

    function retrieveAllItemsInFolder(remoteFolderId, callback) {
        var query = "(trashed=false) and ('" + remoteFolderId + "' in parents)";

        var retrieveSinglePageOfItems = function (items, nextPageToken) {
            var params = { q: query };
            if (nextPageToken)
                params.pageToken = nextPageToken;

            drive.files.list(params, function (err, response) {
                if (err) {
                    invokeLater(err, function () {
                        retrieveAllItemsInFolder(remoteFolderId, callback);
                    });
                    return;
                }

                items = items.concat(response.items);
                var nextPageToken = response.nextPageToken;

                if (nextPageToken)
                    retrieveSinglePageOfItems(items, nextPageToken);

                else
                    callback(items);
            });
        }

        retrieveSinglePageOfItems([]);
    }

    function getOrCreateRemoteBaseHierarchy(remoteFolderPath, callback) {
        var folderSegments = remoteFolderPath.split('/');
        var parentId = 'root';

        var getOrCreateSingleRemoteFolder = function (parentId) {
            var remoteFolderName = folderSegments.shift();

            if (remoteFolderName === undefined)
                // done processing folder segments - invokes the callback
                callback(parentId);

            else {
                var query = "(mimeType='" + FOLDER_MIME + "') and (trashed=false) and (title='" + remoteFolderName + "') and ('" + parentId + "' in parents)";

                drive.files.list({  // note: drive.children.list does not return needed children info (title/md5hash), so using drive.files.list instead
                    maxResults: 1,
                    q: query
                }, function (err, response) {
                    if (err) { console.log('The API returned an error: ' + err); return; }

                    if (response.items.length === 1) {
                        // folder segment already exists, keep going down...
                        var folderId = response.items[0].id;
                        getOrCreateSingleRemoteFolder(folderId);

                    } else {
                        // folder segment does not exist, create the remote folder and keep going down...
                        drive.files.insert({
                            resource: {
                                title: remoteFolderName,
                                parents: [{ "id": parentId }],
                                mimeType: FOLDER_MIME
                            }
                        }, function (err, response) {
                            if (err) { console.log('The API returned an error: ' + err); return; }

                            var folderId = response.id;
                            console.log('+ /', remoteFolderName);
                            getOrCreateSingleRemoteFolder(folderId);
                        });
                    }
                });
            }
        };

        getOrCreateSingleRemoteFolder(parentId);
    }

    function createRemoteItem(localItemFullPath, buffer, remoteFolderId, isDirectory, callback) {
        var localItemName = path.basename(localItemFullPath);

        if (isDirectory && localItemName == ".svn")
            return;

        var itemToInsert = {
            resource: {
                title: localItemName,
                parents: [{ "id": remoteFolderId }]
            }
        };

        if (isDirectory)
            itemToInsert.resource.mimeType = FOLDER_MIME;

        else
            itemToInsert.media = { body: buffer };

        drive.files.insert(itemToInsert, function (err, response) {
            if (err) {
                invokeLater(err, function () {
                    createRemoteItem(localItemFullPath, buffer, remoteFolderId, isDirectory, callback);
                });
                return;
            }

            console.log('+ ', isDirectory ? '/' : '', localItemName);

            if (isDirectory) {
                var folderId = response.id;
                callback(localItemFullPath, folderId);
            }
        });
    }

    function updateSingle(buffer, remoteItem) {
        drive.files.update({
            fileId: remoteItem.id,
            media: { body: buffer }
        }, function (err, response) {
            if (err) {
                invokeLater(err, function () {
                    updateSingle(buffer, remoteItem);
                });
                return;
            }

            console.log('↑ ', remoteItem.title);
        });
    }

    function downloadSingleFile(remoteItem, fullLocalPath) {
        drive.files.get({
            fileId: remoteItem.id,
            alt: 'media'
        }, function (err, data) {
            if (err) {
                invokeLater(err, function () {
                    downloadSingleFile(remoteItem, fullLocalPath);
                });
                return;
            }

            console.log('↓ ', fullLocalPath);
            fs.writeFileSync(fullLocalPath, data);
        });
    }

    function deleteSingleItem(remoteItem) {
        drive.files.delete({
            fileId: remoteItem.id
        }, function (err, response) {
            if (err) {
                invokeLater(err, function () {
                    deleteSingleItem(remoteItem);
                });
                return;
            }

            console.log('- ', remoteItem.title);
        });
    }

    function invokeLater(err, method) {

        var rand = Math.round(Math.random() * 5000);
        console.log('The API returned an error: ' + err + ' - retrying in ' + rand + 'ms');
        setTimeout(function () {
            method();
        }, rand);
    }

    return {
        drive: drive,
        loadCredentials: loadCredentials,
        retrieveAllItemsInFolder: retrieveAllItemsInFolder,
        getOrCreateRemoteBaseHierarchy: getOrCreateRemoteBaseHierarchy,

        createRemoteItem: createRemoteItem,
        updateSingle: updateSingle,
        downloadSingleFile: downloadSingleFile,
        deleteSingleItem: deleteSingleItem
    }
}

function DriveSyncDown() {
    var driveSyncDown = {};
    var self = driveSyncDown;
    driveSyncDown.__proto__ = DriveInteractions();

    function ensureFolderExistsSync(localFolderPath) {
        var mkdirSync = function (basePath) {
            try {
                fs.mkdirSync(basePath);
            } catch (e) {
                if (e.code != 'EEXIST')
                    throw e;
            }
        }

        var parts = localFolderPath.split(path.sep);
        for (var i = 2; i <= parts.length; i++) {
            var basePath = path.join.apply(null, parts.slice(0, i));
            mkdirSync(basePath);
        }
    }

    function rmdirSync(dir, file) {
        var p = file ? path.join(dir, file) : dir;
        if (fs.lstatSync(p).isDirectory()) {
            fs.readdirSync(p).forEach(rmdirSync.bind(null, p));
            fs.rmdirSync(p);
        }
        else
            fs.unlinkSync(p);
    }

    function syncRemoteFolderWithLocalFolder(remoteFolderId, localFolderPath) {
        self.retrieveAllItemsInFolder(remoteFolderId, function (remoteFolderItems) {
            processRemoteItemList(localFolderPath, remoteFolderId, remoteFolderItems);
        });
    }

    function processRemoteItemList(localFolderPath, remoteFolderId, remoteFolderItems) {

        ensureFolderExistsSync(localFolderPath);

        var remoteItemsNotInLocal = []; // keeps track of remote items indexes that were not looked at
        for (var i = 0; i < remoteFolderItems.length; i++)
            remoteItemsNotInLocal.push(i);

        fs.readdirSync(localFolderPath).forEach(function (localItemName) {
            var localItemFullPath = path.join(localFolderPath, localItemName);
            var stat = fs.statSync(localItemFullPath);
            var remoteItemExists = false;

            for (var i = 0; i < remoteFolderItems.length; i++) {
                var remoteItem = remoteFolderItems[i];

                if (remoteItem.title === localItemName) {
                    remoteItemExists = true;

                    if (stat.isDirectory())
                        syncRemoteFolderWithLocalFolder(remoteItem.id, localItemFullPath);

                    else {
                        var md5sum = crypto.createHash('md5');
                        var buffer = fs.readFileSync(localItemFullPath);
                        md5sum.update(buffer);
                        var fileHash = md5sum.digest('hex');

                        if (remoteItem.md5Checksum === fileHash)
                            console.log('= ', localItemFullPath);

                        else
                            self.downloadSingleFile(remoteItem, localItemFullPath);
                    }

                    // item is in both local and remote folders, remove its index from the array
                    remoteItemsNotInLocal = remoteItemsNotInLocal.filter(function (value) { return value != i });
                    break;
                }
            }

            if (!remoteItemExists) {
                console.log('- ', localItemFullPath);
                if (stat.isDirectory())
                    rmdirSync(localItemFullPath);
                else
                    fs.unlinkSync(localItemFullPath);
            }
        });

        // download remoteItems that are not in the local folder
        remoteItemsNotInLocal.forEach(function (index) {
            var remoteItem = remoteFolderItems[index];

            var itemFullPath = localFolderPath + '\\' + remoteItem.title;
            if (remoteItem.mimeType == FOLDER_MIME) {
                syncRemoteFolderWithLocalFolder(remoteItem.id, itemFullPath);

            } else
                self.downloadSingleFile(remoteItem, itemFullPath);
        });
    }

    driveSyncDown.Run = function (remoteFolderPath, localFolderPath) {
        self.loadCredentials(function () {
            self.getOrCreateRemoteBaseHierarchy(remoteFolderPath, function (folderId) {
                syncRemoteFolderWithLocalFolder(folderId, localFolderPath);
            });
        });
    }

    return driveSyncDown;
}

function DriveSyncUp() {
    var driveSyncUp = {};
    var self = driveSyncUp;
    driveSyncUp.__proto__ = DriveInteractions();

    function syncLocalFolderWithRemoteFolder(localFolderPath, remoteFolderId) {
        self.retrieveAllItemsInFolder(remoteFolderId, function (remoteFolderItems) {
            processRemoteItemList(localFolderPath, remoteFolderId, remoteFolderItems);
        });
    }

    function processRemoteItemList(localFolderPath, remoteFolderId, remoteFolderItems) {
        var remoteItemsNotInLocal = []; // keeps track of remote items indexes that were not looked at
        for (var i = 0; i < remoteFolderItems.length; i++)
            remoteItemsNotInLocal.push(i);

        // lists files and folders in localFolderPath
        fs.readdirSync(localFolderPath).forEach(function (localItemName) {
            var localItemFullPath = path.join(localFolderPath, localItemName);
            var stat = fs.statSync(localItemFullPath);

            var buffer;
            if (stat.isFile())
                // if local item is a file, puts its contents in a buffer
                buffer = fs.readFileSync(localItemFullPath);

            var remoteItemExists = false;

            for (var i = 0; i < remoteFolderItems.length; i++) {
                var remoteItem = remoteFolderItems[i];

                if (remoteItem.title === localItemName) { // local item already in the remote item list
                    remoteItemExists = true;

                    if (stat.isDirectory())
                        // synchronizes sub-folders
                        syncLocalFolderWithRemoteFolder(localItemFullPath, remoteItem.id);

                    else {
                        var md5sum = crypto.createHash('md5');
                        md5sum.update(buffer);
                        var fileHash = md5sum.digest('hex');

                        if (remoteItem.md5Checksum === fileHash)
                            console.log('= ', remoteItem.title);

                        else
                            // file already there, but different hash, upload new content!
                            self.updateSingle(buffer, remoteItem);
                    }

                    // item is in both local and remote folders, remove its index from the array
                    remoteItemsNotInLocal = remoteItemsNotInLocal.filter(function (value) { return value != i });
                    break;
                }
            }

            if (!remoteItemExists)
                // local item not found in remoteFolderItems, create the item (file or folder) - and go down if folder
                self.createRemoteItem(localItemFullPath, buffer, remoteFolderId, stat.isDirectory(), function (path, folderId) {
                    syncLocalFolderWithRemoteFolder(path, folderId);
                });
        });

        // removes remoteItems that are not in the local folder (ie not accessed previously)
        remoteItemsNotInLocal.forEach(function (index) {
            var remoteItem = remoteFolderItems[index];
            self.deleteSingleItem(remoteItem);
        });
    }

    driveSyncUp.Run = function (localFolderPath, remoteFolderPath) {
        self.loadCredentials(function () {
            self.getOrCreateRemoteBaseHierarchy(remoteFolderPath, function (folderId) {
                syncLocalFolderWithRemoteFolder(localFolderPath, folderId);
            });
        });
    }

    return driveSyncUp;
}

var syncDown = DriveSyncDown();
syncDown.Run('dev2/test6', 'C:\\tmp\\drive123');

var syncUp = DriveSyncUp();
//syncUp.Run('C:\\tmp\\drive234', 'dev2/test6');