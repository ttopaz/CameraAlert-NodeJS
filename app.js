var fs = require('fs'),
    xml2js = require('xml2js'),
    net = require('net');

var linq = require('node-linq').LINQ;
var express = require('express');
var basicAuth = require('basic-auth');
var bodyParser = require('body-parser');
var http = require('http');
var json = require('express-json');
var errorHandler = require('errorhandler');
var filemon = require('filemonitor');

var app = express();

var currentDevice = 0;

http.globalAgent.maxSockets = 1000;

var cameras = null;
var createEvents = {};
app.set('port', /*process.env.PORT ||*/ 3500);
app.use(json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

if (app.get('env') == 'development') {
    app.use(errorHandler());
}

var auth = function (req, res, next) {
    function unauthorized(res) {
        res.set('WWW-Authenticate', 'Basic realm=Authorization Required');
        return res.send(401);
    };

    var user = basicAuth(req);

    if (!user || !user.name || !user.pass) {
        return unauthorized(res);
    };

    if (user.name === 'admin' && user.pass === 'admin') {
        return next();
    } else {
        return unauthorized(res);
    };
};

app.get('/Cameras', auth, function (req, res) {
    var ret = [];
    Object.keys(cameras).forEach(function (key) {
        ret.push({ Id: key, Name: cameras[key].name, LiveIp: cameras[key].liveip, Files: cameras[key].files });
    });

    console.log(ret);
    res.send(ret);
});


app.get('/GetCameraImage', function (req, res) {
    var path = cameras[req.query.Id].files + "/" + req.query.File;

    var stat = fs.statSync(path);

    var total = stat.size;

    var stream = fs.createReadStream(path);
    stream.on('open', function () {
        res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'image/jpg' });
        stream.pipe(res);
    });
});

app.post('/DeleteCameraFile', function (req, res) {
    var path = cameras[req.body.Id].files + "/" + req.query.File;

    fs.unlink(path, function (err) {
        path = path.replace(".mp4", ".jpg");

        fs.unlink(path, function (err) {
        });

        res.send("OK");
    });
});

var oneDay = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds

app.get('/CameraFiles', auth, function (req, res) {
    var ret = [];

    var path = cameras[req.query.Id].files;

    var days = req.query.Days ? req.query.Days : 0;

    fs.readdir(path, function (err, items) {
        if (items) {
            var currentTime = new Date();

            for (var i = 0; i < items.length; i++) {
                if (req.query.Filter && items[i].indexOf(req.query.Filter) < 0) {
                    continue;
                }
                var file = path + '/' + items[i];

                var stats = fs.statSync(file);
                var date = stats["mtime"];
                var bdate = stats["birthtime"];

                if (days > 0) {
                    var diffDays = Math.round(Math.abs((date.getTime() - currentTime.getTime()) / (oneDay)));
                    if (diffDays > days)
                        continue;
                }

                var item = { File: items[i], Path: file, Size: stats["size"], Date: date, CreateTime: bdate };
                ret.push(item);
            }
        }
        res.send(ret);
    });
});

app.get('/PlayCameraFile', auth, function (req, res) {
    var path = cameras[req.query.Id].files + "/" + req.query.File;

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
        file.on('open', function () {
            file.pipe(res);
        });
    }
    else {
        res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'video/mp4' });

        var stream = fs.createReadStream(path);
        stream.on('open', function () {
            stream.pipe(res);
        });
    }
});

function startMonitoring() {
    console.log("Starting folder monitoring...");

    var targets = [];

    Object.keys(cameras).forEach(function (key) {
        targets.push(cameras[key].files);
    });

    var onFileCreation = function (ev) {
        console.log("File " + ev.filename + " was created on " + ev.timestamp.toString());

        Object.keys(cameras).forEach(function (key) {
            if (ev.filename.substring(0, cameras[key].files.length) == cameras[key].files) {
                createEvents[key] = { file: ev.filename, time: ev.timestamp.toString() };
                console.dir(createEvents);
                return;
            }
        });
    }

    var options = {
        recursive: false,
        targets,
        listeners: {
            create: onFileCreation
        }
    };

    filemon.watch(options);
}

function stopMonitoring() {
    console.log("Stopping folder monitoring...");
    filemon.stop();
}

http.createServer(app).listen(app.get('port'), function () {
    console.log('Express server listening on port ' + app.get('port'));
});

console.log("Loading Camera data...");

fs.readFile(__dirname + '/cameras.json', function (err, data) {
    cameras = JSON.parse(data);
    startMonitoring();
});

process.on("exit", function () {
    stopMonitoring();
});


