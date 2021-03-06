/**
 * Init
 */
var httpreq 	= require('httpreq');
var OAuth       = require('oauth').OAuth;
var querystring = require('querystring');
var config 		= require('./config');
var util 		= require('util');
var async 		= require('async');
var cheerio 	= require('cheerio');
var _ 			= require('underscore');
var express 	= require('express');
var http 		= require('http')
var path 		= require('path');
var socketio 	= require('socket.io');

var app = express();

var debugtest = false;

app.configure(function(){
	app.set('port', process.env.PORT || 3000);
	app.set('views', __dirname + '/views');
	app.set('view engine', 'jade');
	app.use(express.favicon());
	app.use(express.logger('dev'));
	app.use(express.bodyParser());
	app.use(express.methodOverride());
	app.use(express.cookieParser('123456789987654321'));
	app.use(express.session());
	app.use(app.router);
	app.use(require('stylus').middleware(__dirname + '/public'));
	app.use(express.static(path.join(__dirname, 'public')));
});

app.configure('development', function(){
	app.use(express.errorHandler());
});

var server = http.createServer(app).listen(app.get('port'), function(){
	console.log("Express server listening on port " + app.get('port'));
});

var io = require('socket.io').listen(server);
io.set('log level', 0); // geen socket.io debug info, thx!

// authentication for other twitter requests
var twitterOAuth = new OAuth(
	"https://api.twitter.com/oauth/request_token",
	"https://api.twitter.com/oauth/access_token",
	config.twitter.consumerKey,
	config.twitter.consumerSecret,
	"1.0",
	null,
	"HMAC-SHA1"
);

// some variable to hold the state of the app
var State = {
	onepercentpictures: [],
	importantpictures: []
};

/**
 * Functies en andere logica
 */

// Webserver root page:
app.get('/', function (req, res){
	res.render('index', {
		title: 'A thousand twitter pictures'
	});
});


app.get('/filter', function (req, res){
	res.render('index2', {
		title: 'A thousand twitter pictures'
	});
});

// Javascript die alle urls bevat van pictures die al gevonden zijn:
app.get('/server.js', function (req, res){
	// interweave the important pictures with the onepercentpictures:

	var allpictures = [];

	var offset = 100;

	var insertEveryXpictures = (State.onepercentpictures.length - offset)/State.importantpictures.length;

	var i = 0;
	var n = 1;
	for(var x in State.onepercentpictures){
		if(x > (offset + insertEveryXpictures*n) ){
			n++;
			allpictures.push({url:State.importantpictures[i], important: true});
			i++;
		}

		allpictures.push({url:State.onepercentpictures[x], important: false});
	}

	// possible the rest of the importantpictures
	while(i < State.importantpictures.length){
		allpictures.push({url:State.importantpictures[i], important: true});
		i++;
	}

	res.send("App.alreadyfoundpictures = " + JSON.stringify(allpictures) + ";");
});

app.get('/start', function (req, res){
	res.json("OK");
	io.sockets.emit('start', {});
});


// Begin met pictures te zoeken:
init();

function init(){
	startSimpleSearch();
	startSearchHose();
	startOnePercenthose();
}


function startSimpleSearch(){
	// 1.) Zoek naar pictures met bepaald hashtag:
	var parameters = querystring.stringify({
		q: config.app.searchterms.join(' OR '),
		result_type: 'mixed',
		count: 100,
		include_entities: true
	});

	twitterOAuth.getProtectedResource('https://api.twitter.com/1.1/search/tweets.json?' + parameters, "GET", config.twitter.token, config.twitter.secret,
		function (err, data, res){
			if(err) return console.log(err);

			data = JSON.parse(data);
			var tweets = data.statuses;

			async.forEach(tweets, function (tweet, c){
				getPictureUrlsFromTweet(tweet, function (err, pictures){
					if(err) return c(err);

					//console.log(pictures);

					for(var i in pictures)
						addPicture(pictures[i], State.importantpictures);

					c(null);
				});
			}, function (err){
				if(err) return console.log(err);
			});
		}
	);
}


function startSearchHose(){
	// 2.) Luister ook naar nieuwe pictures die binnenkomen:
	var parameters = querystring.stringify({
		track: config.app.searchterms.join(',')
	});

	var twitterhose = twitterOAuth.get('https://stream.twitter.com/1.1/statuses/filter.json?' + parameters, config.twitter.token, config.twitter.secret);
	twitterhose.addListener('response', function (res){
		console.log("searchhose started");
		res.setEncoding('utf8');
		res.addListener('data', function (chunk){
			try{
				var tweet = JSON.parse(chunk);

				// extract picture urls:
				getPictureUrlsFromTweet(tweet, function (err, pictures){
					if(err) return console.log(err);

					for(var i in pictures)
						addPicture(pictures[i], State.importantpictures);
				});
			}catch(err){}
		});

		res.addListener('end', function(){
			console.log("Twitterhose broke down");
		});
	});
	twitterhose.end();
}


function startOnePercenthose(){
	if(config.twitter2.token && config.twitter2.secret){
		// need a second account for a second streaming connection:
		var twitterOAuth2 = new OAuth(
			"https://api.twitter.com/oauth/request_token",
			"https://api.twitter.com/oauth/access_token",
			config.twitter2.consumerKey,
			config.twitter2.consumerSecret,
			"1.0",
			null,
			"HMAC-SHA1"
		);

		// 3.) de 1% hose
		var onepercenthose = twitterOAuth2.get('https://stream.twitter.com/1.1/statuses/sample.json', config.twitter2.token, config.twitter2.secret);
		onepercenthose.addListener('response', function (res){
			console.log("onepercenthose started");
			res.setEncoding('utf8');
			res.addListener('data', function (chunk){

				try{
					var tweet = JSON.parse(chunk);

					// extract picture urls:
					getPictureUrlsFromTweet(tweet, function (err, pictures){
						if(err) return console.log(err);

						for(var i in pictures)
							addPicture(pictures[i], State.onepercentpictures);
					});
				}catch(err){}
			});

			res.addListener('end', function(){
				console.log("onepercenthose broke down");
			});
		});
		onepercenthose.end();
	}
}


function addPicture(picture, array){
	if(picture){

		if(!_.contains(array, picture)){

			var arrayname = "";
			var important = false;
			if(array == State.onepercentpictures)
				arrayname = "onepercentpictures";
			if(array == State.importantpictures){
				arrayname = "importantpictures";
				var important = true;
			}

			console.log("Adding to "+arrayname+" " + picture);
			array.push(picture);
			// stuur maar direct naar de client ook:
			io.sockets.emit('newpicture', {url: picture, important: important});

			cleanPictures();
		}
	}
}

function cleanPictures(){
	//cleans up the pictures taking into account the maximumpictures settings from the config file:

	if( State.importantpictures.length > config.app.maximumpictures ){
		State.importantpictures = State.importantpictures.slice(-config.app.maximumpictures);
	}

	var picturesLeftToFill = config.app.maximumpictures - State.importantpictures.length;

	if( State.onepercentpictures.length > picturesLeftToFill ){

		State.onepercentpictures = State.onepercentpictures.slice(-picturesLeftToFill)

		if(picturesLeftToFill == 0)
			State.onepercentpictures = [];
	}
}

/**
 * Picture extraction functions:
 */
function getPictureUrlsFromTweet(tweet, callback){
	var pictureUrls = [];


	//pictures en urls zitten in tweet.entities:
	if(tweet.entities.media){
		for(var j in tweet.entities.media){
			var media = tweet.entities.media[j];
			if(media.type == 'photo'){
				pictureUrls.push(media.media_url);
			}
		}
	}

	// we gaan ook op zoek naar de instagram urls:
	var instagramUrls = [];

	if(tweet.entities.urls){
		for(var j in tweet.entities.urls){
			var url = tweet.entities.urls[j];
			if(url.expanded_url.match(/http(s)?:\/\/instagr.am\/.+/i)){
				instagramUrls.push(url.expanded_url);
			}
		}
	}

	// de instagram urls parsen:
	extractInstagramUrls(instagramUrls, function (err, extractedUrls){
		if(err) return callback(err);

		// urls toevoegen aan pictureUrls:
		pictureUrls = pictureUrls.concat(extractedUrls);

		// done:
		callback(null, pictureUrls);
	});
}

function extractInstagramUrls(urls, callback){
	var extractedUrls = [];

	async.forEach(urls, function (url, c){
		extractInstagramUrl(url, function (err, extractedUrl){
			if(err) return c(err);
			extractedUrls.push(extractedUrl);
			c(null);
		});
	}, function (err){
		if(err) return callback(err);

		callback(null, extractedUrls);
	});
}

function extractInstagramUrl(url, callback){
	httpreq.get(url, function (err, res){
		if(err) return callback(err);

		// check for redirects:
		if(res.headers.location){
			extractInstagramUrl(res.headers.location, callback);
		}else{
			try{
				var $ = cheerio.load(res.body);
				var extractedUrl = $("#media_photo .photo").attr('src');
				callback(null, extractedUrl);
			}catch(err){
				callback(err);
			}
		}
	});
}














