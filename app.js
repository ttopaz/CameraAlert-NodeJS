
const dotenv = require('dotenv').config({path: __dirname + "/.env"});
const fs = require('fs');
const xml2js = require('xml2js');
const net = require('net');
const express = require('express');
const basicAuth = require('basic-auth');
const bodyParser = require('body-parser');
const http = require('http');
const cors = require('cors');
const json = require('express-json');
const errorHandler = require('errorhandler');
const ringApi = require( 'doorbot' );
const watch = require('node-watch');
const admin = require("firebase-admin");

var serviceAccount = require("./camera-alert-12580-firebase-adminsdk-cgeu0-6a7ad66e8a.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://camera-alert-12580.firebaseio.com"
});

var registrationTokens = [
    'fQ0CPq2uNbw:APA91bF-tTtWR5W6cXtTkyExJF36AgC29nmhTjQJk0i42vqqOkLSHecBi4zJ2opcvH95d-1Rscs-HlugJDqONJC04cq5MYtQNQ-BSGCa3nt5zWpHxDXTKXQtcKicV185kIlQI4F7rSG5aBN1_SQkakq9xXb9E93kGQ'
];

const app = express();

const currentDevice = 0;    

http.globalAgent.maxSockets = 1000;

var cameras = null;

//dotenv.load()

app.set('port', process.env.PORT || 3500);
app.use(json());
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

if (app.get('env') == 'development') {
    app.use(errorHandler());
}

var auth = (req, res, next) => {
    function unauthorized(res) {
        res.set('WWW-Authenticate', 'Basic realm=Authorization Required');
        return res.send(401);
    };

    var user = basicAuth(req);

    if (!user || !user.name || !user.pass) {
        console.log("unauthorized");
        return unauthorized(res);
    };
    if (user.name === process.env.USERNAME && user.pass === process.env.PASSWORD) {
        return next();
    } else {
        return unauthorized(res);
    };
};

app.get('/Cameras', auth, (req, res) => {
    var ret = [];
    Object.keys(cameras).forEach((key) => {
        ret.push({ Id: key, Name: cameras[key].name, LiveIp: cameras[key].liveip, 
	    LiveVideo : cameras[key].livevideo, Files: cameras[key].files,
            Username : cameras[key].username, Password : cameras[key].password, 
            Type : cameras[key].type, DeviceId : cameras[key].deviceId });
    });

    console.log(ret);
    res.send(ret);
});


app.get('/GetCameraImage', (req, res) => {
    if (cameras[req.query.Id].type == "ring")
    {
        res.send(null);
    }
    else
    {
        var path = req.query.File;

        try {
            var stat = fs.statSync(path);

            var total = stat.size;

            var stream = fs.createReadStream(path);
            stream.on('open', () => {
                res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'image/jpg' });
                stream.pipe(res);
            });
        }
        catch (e) {
            res.send(null);
        }
    }
});

app.post('/DeleteCameraFile', (req, res) => {
    var path = cameras[req.body.Id].files + "/" + req.query.File;

    fs.unlink(path, (err) => {
        path = path.replace(".mp4", ".jpg");

        fs.unlink(path, function (err) {
        });

        res.send("OK");
    });
});

app.post('/SetToken', (req, res) => {
    var token = req.body.Token;

    registrationTokens = [token];

    console.log("token: " + token);
    res.send("OK");
});

app.get('/GetCameraEvent', auth, (req, res) => {

    if (cameras[req.query.Id].changed != undefined)
    {
        ret.send({ cameraId: key, cameraName: cameras[req.query.Id].name, file: cameras[req.query.Id].changed.file, date: cameras[req.query.Id].changed.date });
    }
    else {
        res.send(null);
    }
});

app.get('/GetEvents', auth, (req, res) => {
    var ret = [];

    Object.keys(cameras).forEach((key) => {
        var camera = cameras[key];
        if (camera.changed != null)
        {
            ret.push({ cameraId: key, cameraName: camera.name, file: camera.changed.file, date: camera.changed.date.toISOString() });            
            camera.changed = null;
        }
    });

    console.log(ret);
    res.send(ret);
});

var oneDay = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds

app.get('/CameraFiles', auth, (req, res) => {

    if (cameras[req.query.Id] == undefined)
        return;

    var days = req.query.Days ? req.query.Days : 0;

    if (cameras[req.query.Id].type == "ftp")
        getFtpFiles(req.query.Id, cameras[req.query.Id].files, days, req.query.Date, req.query.Filter, res);
    else if (cameras[req.query.Id].type == "ring")
        getRingFiles(req.query.Id, cameras[req.query.Id].deviceId, 0, null, res);
});

function getRingFiles(id, deviceId, days, filter, res)
{
    const ring = ringApi( {
        email: cameras[id].username.replace("{RINGUSERNAME}", process.env.RINGUSERNAME),
        password: cameras[id].password.replace("{RINGPASSWORD}", process.env.RINGPASSWORD),
        retries: 10,
        userAgent: 'toptoncode',
        poll: true,
    });

    var files = [];

    ring.history((e, history) => {
        history.forEach(function (event) 
        {
            var item = { Name : event.kind, File: event.id, Path: event.id, ImagePath: null, Size: 0
                , videoUrlProvider: "/PlayCameraFile?Id=" + id + "&File=" + event.id
                , Date: event.created_at, CreateTime: event.created_at };
            files.push(item);
        });
        res.send(files); 
    });
}

function getPaddedValue(value)

 {   if (parseInt(value) > 9)
        return value.toString();
    else
        return "0" + value.toString();                
}

function getFtpFiles(id, basePath, days, dateFilter, filter, res)
{
    if (!dateFilter)
    {
        if (!cameras[id].results || !cameras[id].results.length)
        {
            if (cameras[id].hasDirs)
            {
                var today = new Date();
                dateFilter = today.getFullYear() + "/" + today.getMonth() + "/" + today.getDate();
                var path = basePath + "/" + today.getFullYear() + "/" + getPaddedValue(today.getMonth() + 1) + "/" + getPaddedValue(today.getDate());
                var data = loadFtpFiles(id, path, days, dateFilter, filter);

                today.setDate(today.getDate() - 1);
                dateFilter = today.getFullYear() + "/" + today.getMonth() + "/" + today.getDate();
                path = basePath + "/" + today.getFullYear() + "/" + getPaddedValue(today.getMonth() + 1) + "/" + getPaddedValue(today.getDate());
                data = data.concat(loadFtpFiles(id, path, days, dateFilter, filter));

                cameras[id].results = data;
            }
            else
                cameras[id].results = loadFtpFiles(id, basePath, days, dateFilter, filter);
        }
        res.send(cameras[id].results);
    }
    else
    {
        if (cameras[id].hasDirs)
        {
            var parts = dateFilter.split("/");
            basePath += "/" + parts[0] + "/" + getPaddedValue(parseInt(parts[1]) + 1) + "/" + getPaddedValue(parts[2]);
        }
        res.send(loadFtpFiles(id, basePath, days, dateFilter, filter));
    }
}

function loadFtpFiles(id, basePath, days, dateFilter, filter)
{
    var files = [];

    var currentTime = new Date();

    var maxFiles = 50;

    var checkDate = null;

    if (dateFilter)
    {
        var parts = dateFilter.split("/");
        checkDate = new Date(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]));
        maxFiles = 0;
    }

    function walkDir(rootPath) {

        var items;
        try {
            items = fs.readdirSync(rootPath);
        }
        catch (e)
        {
            return;
        }

        if (items) {
            for (var i = 0; i < items.length; i++) {
                var path = rootPath + '/' + items[i];

                var stats = fs.statSync(path);
                if (stats.isDirectory()) {
                    walkDir(path);
                }
                else {

                    if (filter && items[i].indexOf(filter) < 0) {
                        continue;
                    }

                    var date = stats["mtime"];
                    var bdate = stats["birthtime"];

                    if (checkDate)
                    {
                        var yearMonthDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
                        if (yearMonthDay > checkDate)
                        {
                            return;
                        }
                        if (yearMonthDay < checkDate)
                        {
                            continue;
                        }
                    }
                    else if (days > 0) {
                        var diffDays = Math.round(Math.abs((date.getTime() - currentTime.getTime()) / (oneDay)));
                        if (diffDays > days)
                            continue;
                    }

                    var imagePath = getVideoImagePath(path);

                    var item = { Name : "motion", File: path, Path: path, imageUrl: "/GetCameraImage?Id=" + id + "&File=" + imagePath
                        , videoUrl: "/PlayCameraFile?Id=" + id + "&File=" + path
                        , Size: stats["size"], Date: date, CreateTime: bdate };
                    files.push(item);
                }
            }
        }
    }

    walkDir(basePath);

    files.sort(function (a, b) {
        return a.Date > b.Date ? -1 : 1;
    });

    if (maxFiles)
        return files.slice(0, maxFiles);
    else
        return files;                
};

function getVideoImagePath(path) {
    return path.replace(".mp4", ".jpg");
}

app.get('/PlayCameraFile', auth, (req, res) => {
    if(cameras[req.query.Id].type == "ring")
    {
        const ring = ringApi( {
            email: cameras[req.query.Id].username,
            password: cameras[req.query.Id].password,
            retries: 10,
            userAgent: 'toptoncode',
            poll: true,
        } );
        ring.recording(req.query.File, (e, recording) => {
            res.send( { Url : recording } );
        });
    }
    else
    {
        var path = req.query.File;

        var stat = fs.statSync(path);

        var total = stat.size;
        if (req.headers['range']) {
            var range = req.headers.range;
            var parts = range.replace(/bytes=/, "").split("-");
            var partialstart = parts[0];
            var partialend = parts[1];

            var start = parseInt(partialstart, 10);
            var end = partialend ? parseInt(partialend, 10) : total - 1;

            var chunksize = (end - start) + 1;

            var file = fs.createReadStream(path, { start: start, end: end });
            res.writeHead(206, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + total, 'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': 'video/mp4' });
            file.on('open', () => {
                file.pipe(res);
            });
        }
        else {
            res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'video/mp4' });

            var stream = fs.createReadStream(path);
            stream.on('open', () => {
                stream.pipe(res);
            });
        }
    }
});

app.get('/PlayLiveVideo', auth, (req, res) => {
    res.send({ status : "OK" });
});

http.createServer(app).listen(app.get('port'), () => {
    console.log('Express server listening on port ' + app.get('port'));
});

console.log("Loading Camera data...");

function sendMessage(camera, file, date)
{
    var payload = {
        data : {
            cameraId : camera.id,
            cameraName : camera.name,
            file : file,
            date : date.toISOString()
        }
    };

    admin.messaging().sendToDevice(registrationTokens, payload)
    .then((response) => {
        console.log('Sent successfully.\n');
        console.log(response);
    })
    .catch((error) => {
        console.log('Sent failed.\n');
        console.log(error);
    });
}

fs.readFile(__dirname + '/cameras.json', (err, data) => {
    cameras = JSON.parse(data);

    Object.keys(cameras).forEach((key) => {
        var camera = cameras[key];
        camera.id = key;
        if (camera.type == "ftp")
        {
  //          camera.username = camera.username.replace("{RINGUSERNAME}", process.env.RINGUSERNAME);
  //          camera.password = camera.username.replace("{RINGPASSWORD}", process.env.RINGPASSWORD);
            camera.lastChanged = null;
            camera.results = null;
            camera.changed = null;
            watch(camera.files, { recursive: true }, function(evt, name) {
                var cname = name.replace(".jpg", ".mp4");
                if (camera.lastChanged != cname)
                {
                    console.log('%s changed', name);
                    camera.results = loadFtpFiles(key, camera.files, 1, ".mp4");    
                    camera.changed = { file: name.substring(camera.files.length + 1), date: new Date() };
                    camera.lastChanged = cname;
                    sendMessage(camera, camera.changed.file, camera.changed.date);
                }
            });
        }
     /*   else
        {
            camera.liveip = camera.liveip.replace("{VDUSERNAME}", process.env.VDUSERNAME);
            camera.liveip = camera.liveip.replace("{VDPASSWORD}", process.env.VDPASSWORD);
            camera.livevideo = camera.liveip.replace("{VDUSERNAME}", process.env.VDUSERNAME);
            camera.livevideo = camera.liveip.replace("{VDPASSWORD}", process.env.VDPASSWORD);
        }*/
    });
});

process.on("exit", () => {
});
