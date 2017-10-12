'use strict';

var async = require('async');
var url = require('url');
var fs = require('fs');
var request = require('request');
var DefaultInterceptor = require('./interceptor');

function APIEntry(apiclient, prev, data) {
	this.apiclient = apiclient;
	this.path = prev.path;
	this.requireAuth = prev.requireAuth;
	this.requireToken = prev.requireToken;
	this.method = 'GET';
	this.data = null;

	if (data.hasOwnProperty('path') && data.path != '') {
		if (this.path == '') {
			this.path = data.path;
		} else {
			this.path = this.path + '/' + data.path;
		}
	}

	if (data.hasOwnProperty('method')) {
		this.method = data.method.toUpperCase();
	}

	if (data.hasOwnProperty('requireAuth')) {
		this.requireAuth = data.requireAuth;
	}

	if (data.hasOwnProperty('requireToken')) {
		this.requireToken = data.requireToken;
	}

	if (data.hasOwnProperty('data')) {
		this.data = data.data;
	}
}

APIEntry.prototype.getVariable = function (config, varname) {
	if (config.hasOwnProperty(varname)) {
		return config[varname];
	} else {
		return '@' + varname;
	}
}

APIEntry.prototype.generateUrl = function (config, args) {
	var r1 = /^(.*\/)@([a-z]+)(.*)$/;
	var r2 = /^(.*\/)\$(\d+)(.*)$/;
	var tail = '';
	var left = this.path;
	var m;

	if ((m = r1.exec(left)) != null) {
		left = m[1] + this.getVariable(config, m[2]) + m[3];
	} else {
		while ((m = r2.exec(left)) != null) {
			var idx = Number(m[2]) - 1;
			left = m[1];
			tail = args[idx] + m[3] + tail;
		}
	}
	return left + tail;
}

APIEntry.prototype.callfunc = function (config, fcn, variable, callback) {
	this.apiclient.interceptor.functionCall(fcn, variable, callback);
}

APIEntry.prototype.generateDataValue = function (val, config, args, optional, callback) {
	var r1 = /^([a-z][_a-z0-9]+)\(\$(#?)(\d+)\)\s*$/;
	var r2 = /^\$(#?)(\d+)\s*$/;
	var r3 = /^@([a-z][_a-zA-Z0-9]+)$/;
	var m;
	var idx = 0;
	var func = null;
	var isNumeric = false;

	if ((m = r1.exec(val)) != null) {
		func = m[1];
		idx = Number(m[3]) - 1;
		isNumeric = m[2] == '#';
	} else if ((m = r2.exec(val)) != null) {
		idx = Number(m[2]) - 1;
		isNumeric = m[1] == '#';
	} else if ((m = r3.exec(val)) != null) {
		callback(null, config[m[1]]);
		return;
	} else {
		callback(null, val);
		return;
	}

	if (idx < 0 || idx >= args.length) {
		if (optional) {
			callback(null, null);
		} else {
			callback(new Error("missing argument"), null);
		}
	} else {
		var result = args[idx];

		if (isNumeric) {
			result = parseInt(result, 10);
		}

		if (func != null) {
			this.callfunc(config, func, result, callback);
		} else {
			callback(null, result);
		}
	}
}

APIEntry.prototype.generateData = function (config, args, callback) {
	var data = {};
	var self = this;

	if (this.data != null) {
		async.forEachOf(self.data, function (value, key, callback) {
			var k = key.split(":");
			var optional = k[1] == 'optional';

			self.generateDataValue(value, config, args, optional, function (err, result) {
				if (err != null) {
					callback(err);
				} else if (result != null) {
					data[k[0]] = result;
					callback(null);
				} else {
					callback(null);
				}
			});
		}, function (err) {
			callback(err, data);
		});
	} else {
		callback(null, data);
	}
}

APIEntry.prototype.apicall = function (config, args) {
	var callback = args.length > 0 ? args[args.length - 1] : null;
	var self = this;

	if (callback != null) {
		if (typeof(callback) == 'function') {
			args.pop();
		} else {
			callback = null;
		}
	}

	if (callback == null) {
		callback = function (err, result) {
		}
	}

	var options = {
		url: config.base + '/' + this.generateUrl(config, args),
		method: this.method,
		json: true,
	};

	if (this.requireAuth) {
		options['auth'] = {
			'user': config.user,
			'pass': config.secret,
		}
	} else if (this.requireToken) {
		options['auth'] = {
			'bearer': config.token
		}
	}

	async.waterfall([
		function (cb) {
			if (self.data != null) {
				options['body'] = self.generateData(config, args, function (err, result) {
					if (err != null) {
						cb(err);
					} else {
						options['body'] = result;
						cb(null);
					}
				});
			} else {
				callback(null);
			}
		},
	], function (err) {
		if (err) {
			callback(err);
		} else {
			request(options, function (err, res, body) {
				if (err != null) {
					self.apiclient.interceptor.postApiCall(err, null, callback);
				} else {
					self.apiclient.interceptor.postApiCall(null, body, callback);
				}
			});
		}
	});

}

function MetaData(apiclient, jsonfile) {
	var meta = JSON.parse(fs.readFileSync(jsonfile, 'utf8'));

	this.description = meta.description;
	this.version = meta.version;
	this.path = meta.path;
	this.recursiveBuild(apiclient, {
		path: meta.path,
		requireAuth: false,
		requireToken: false,
	}, meta.apis);
}

MetaData.prototype.recursiveBuild = function (apiclient, prev, apimap) {
	var self = this;

	Object.keys(apimap).forEach(function (key) {
		var value = apimap[key];
		var newNode = new APIEntry(apiclient, prev, value);

		if (value.hasOwnProperty('apis')) {
			self.recursiveBuild(apiclient, newNode, value.apis);
		} else {
			apiclient.regist(key, new APIEntry(apiclient, prev, value));
		}
	});
}

function APIClient(config, jsonfile, interceptor) {
	this.config = config;
	this.interceptor = interceptor;
	this.apis = {};
	this.meta = new MetaData(this, jsonfile);
}

APIClient.prototype.regist = function (name, entry) {
	this.apis[name] = entry;
	APIClient.prototype[name] = function () {
		this._doApiCall(name, Array.prototype.slice.call(arguments));
	}
}

APIClient.prototype._doApiCall = function (name, args) {
	if (this.apis.hasOwnProperty(name)) {
		return this.apis[name].apicall(this.config, args);
	} else {
		throw new Error(name + ": apicall not found");
	}
}

exports.version = "1.0.3";

exports.New = function (config, jsonfile, interceptor) {
	return new APIClient(config, jsonfile, interceptor != null ? interceptor : new DefaultInterceptor);
}
