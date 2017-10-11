'use strict';

function Interceptor() {
}

Interceptor.prototype.postApiCall = function (err, result, callback) {
	callback(err, result);
}

Interceptor.prototype.functionCall = function (fname, arg, callback) {
	callback(null, fname + "(" + arg + ")");
}

module.exports = Interceptor;
