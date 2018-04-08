var fs = require('fs'),
    xml2js = require('xml2js'),
    net = require('net');

var linq = require('node-linq').LINQ;
var express = require('express');
var basicAuth = require('basic-auth');
var bodyParser = require('body-parser');
var http = require('http');
var cors = require('cors');
//var lwip = require('lwip');
var json = require('express-json');
var errorHandler = require('errorhandler');
var filemon = require('filemonitor');
const RingApi = require( 'doorbot' );

var app = express();

var currentDevice = 0;

http.globalAgent.maxSockets = 1000;

var cameras = null;
var createEvents = {};
app.set('port', /*process.env.PORT ||*/ 3500);
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

    console.log("request");

    var user = basicAuth(req);

    if (!user || !user.name || !user.pass) {
        console.log("unauthorized");
        return unauthorized(res);
    };

    if (user.name === 'admin' && user.pass === 'admin') {
        return next();
    } else {
        return unauthorized(res);
    };
};

app.get('/Cameras', auth, (req, res) => {
    var ret = [];
    Object.keys(cameras).forEach((key) => {
        ret.push({ Id: key, Name: cameras[key].name, LiveIp: cameras[key].liveip, Files: cameras[key].files,
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
    var path = /*cameras[req.query.Id].files + "/" + */req.query.File;

    try {
/*         if (req.query.Width)
         {
            lwip.open(path, function (err, image) {
                 var ratio = image.height() / image.width();
                 image.resize(parseInt(req.query.Width), ratio * parseInt(req.query.Width), function(err, image) {
                    image.toBuffer("jpg", function(err, buffer)
                    {
                        res.send(buffer);
                    });
                 });
             });
        }
        else*/
        {
            var stat = fs.statSync(path);

            var total = stat.size;

            var stream = fs.createReadStream(path);
            stream.on('open', () => {
                res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'image/jpg' });
                stream.pipe(res);
            });
        }
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

app.get('/GetCameraEvent', auth, (req, res) => {
    if (createEvents[req.query.Id] && createEvents[req.query.Id] != undefined) {
        ret.send({ cameraId: key, cameraName: cameras[key].name, file: createEvents[req.query.Id].file, date: createEvents[req.query.Id].date });
    }
    else {
        res.send(null);
    }
});

app.get('/GetEvents', auth, (req, res) => {
    var ret = [];

    Object.keys(createEvents).forEach(function (key) {
        ret.push({ cameraId: key, cameraName: cameras[key].name, file: createEvents[key].file, date: createEvents[key].date });
    });

    res.send(ret);
});

var oneDay = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds

app.get('/CameraFiles', auth, (req, res) => {

    var days = req.query.Days ? req.query.Days : 0;

    if (cameras[req.query.Id].type == "ftp")
        getFtpFiles(req.query.Id, cameras[req.query.Id].files, days, req.query.Filter, res);
    else if (cameras[req.query.Id].type == "ring")
        getRingFiles(req.query.Id, cameras[req.query.Id].deviceId, 0, null, res);
});

function getRingFiles(id, deviceId, days, filter, res)
{
    const ringApi =  RingApi( {

        // note - that the email and password can also be given by setting the RING_USER 
        // and RING_PASSWORD environment variables. This is better if you want to keep
        // passwords out of your source code
        email: cameras[id].username,
        password: cameras[id].password,
    
        // OPTIONAL: any user agent you want to use default is the github
        // url of this project: 'http://github.com/jimhigson/ring-api'
        // note that this wont be used if running in a browser because this header
        // is considered unsafe
        userAgent: 'http://github.com/jimhigson/ring-api',
    
        // OPTIONAL: if true, will poll behind the scenes. Listening for
        // events only works if this is on. True by default.
        poll: true,
        
    } );

    var files = [];

    ringApi.history((e, history) => {
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

function getFtpFiles(id, basePath, days, filter, res)
{
    var files = [];

    var currentTime = new Date();

    function walkDir(rootPath) {

        var items = fs.readdirSync(rootPath);

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

                    if (days > 0) {
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

    res.send(files);
};

function getVideoImagePath(path) {
    return path.replace(".mp4", ".jpg");
}

app.get('/PlayCameraFile', auth, (req, res) => {
    if(cameras[req.query.Id].type == "ring")
    {
        const ringApi =  RingApi( {

            // note - that the email and password can also be given by setting the RING_USER 
            // and RING_PASSWORD environment variables. This is better if you want to keep
            // passwords out of your source code
            email: cameras[req.query.Id].username,
            password: cameras[req.query.Id].password,
        
            // OPTIONAL: any user agent you want to use default is the github
            // url of this project: 'http://github.com/jimhigson/ring-api'
            // note that this wont be used if running in a browser because this header
            // is considered unsafe
            userAgent: 'http://github.com/jimhigson/ring-api',
        
            // OPTIONAL: if true, will poll behind the scenes. Listening for
            // events only works if this is on. True by default.
            poll: true,
          
        } );
        ringApi.recording(req.query.File, (e, recording) => {
            res.send( { Url : recording } );
        });
    }
    else
    {
    var path = /*cameras[req.query.Id].files + "/" + */req.query.File;

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

function startMonitoring() {
    console.log("Starting folder monitoring...");

    var targets = [];

    Object.keys(cameras).forEach((key) => {
        targets.push(cameras[key].files);
    });

    var onFileCreation = (ev) => {
        console.log("File " + ev.filename + " was created on " + ev.timestamp.toISOString());

        Object.keys(cameras).forEach(function (key) {
            if (ev.filename.substring(0, cameras[key].files.length) == cameras[key].files) {
                createEvents[key] = { file: ev.filename.substring(cameras[key].files.length + 1), date: ev.timestamp };
                console.dir(createEvents);
                return;
            }
        });
    }

    var options = {
        recursive: false,
        target: targets,
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

http.createServer(app).listen(app.get('port'), () => {
    console.log('Express server listening on port ' + app.get('port'));
});

console.log("Loading Camera data...");

fs.readFile(__dirname + '/cameras.json', (err, data) => {
    cameras = JSON.parse(data);
//    startMonitoring();
});

process.on("exit", () => {
    //stopMonitoring();
});
