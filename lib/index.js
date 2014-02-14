/*
 * Copyright 2013 Yahoo! Inc. All rights reserved.
 * Copyrights licensed under the BSD License.
 * See the accompanying LICENSE.txt file for terms.
 */


/*jslint nomen:true, anon:true, node:true */
"use strict";


var libfs       = require('fs'),
    util        = require('util'),
    libpath     = require('path'),
    Promise     = require('ypromise'),
    libycb      = require('ycb'),
    libjson5    = require('json5'),
    libyaml     = require('yamljs'),
    libcache    = require('lru-cache'),
    MESSAGES = {
        'unknown bundle': 'Unknown bundle "%s"',
        'unknown config': 'Unknown config "%s" in bundle "%s"',
        'unknown cache data': 'Unknown cache data with config "%s" in bundle "%s"',
        'missing dimensions': 'Failed to find a dimensions.json file',
        'parse error': 'Failed to parse "%s"\n%s'
    },
    DEFAULT_CACHE_OPTIONS = {
        max: 250
    };

function clone(o) {
    return JSON.parse(JSON.stringify(o));
}

function mix(target, source, overwrite) {
    for (var prop in source) {
        if (source.hasOwnProperty(prop) && (overwrite || !target.hasOwnProperty(prop))) {
            target[prop] = source[prop];
        }
    }
    return target;
}

/**
 * A component for reading configuration files.
 * @module ModownConfig
 */


/**
 * Determines if a config is YCB or not.
 * @private
 * @static
 * @method contentsIsYCB
 * @param {mixed} contents The config contents.
 * @return {boolean} Whether the config is YCB or not.
 */
function contentsIsYCB(contents) {
    var s,
        section;
    // not sure what this is
    if ('object' !== typeof contents) {
        return false;
    }
    if (Array.isArray(contents) && contents.length) {
        for (s = 0; s < contents.length; s += 1) {
            section = contents[s];
            if (!section.settings) {
                return false;
            }
            if (!Array.isArray(section.settings)) {
                return false;
            }
        }
        return true;
    }
    return false;
}

/**
 * Creates a cache key that will be one-to-one for each context object,
 * based on their contents.  JSON.stringify does not guarantee order for
 * two objects that have the same contents, so we need to have this.
 * @private
 * @static
 * @method getCacheKey
 * @param {mixed} context The context object.
 * @return {string} A JSON-parseable string that will be the same for all equivalent context objects.
 */

function getCacheKey(context) {
    var a = [],
        KV_START   = '"',
        KV_END     = '"',
        JSON_START = '{',
        JSON_END   = '}',
        key;

    for (key in context) {
        a.push([KV_START + key + KV_END, 
                KV_START + context[key] + KV_END].join(':'));
    }

    a.sort();
    return JSON_START + a.toString() + JSON_END;
}

/**
 * Create the YCB object.
 * @private
 * @static
 * @method makeYCB
 * @param {Config} config The config object.
 * @param {object} dimensions The dimensions definitions.
 * @param {array} contents The contents of the YCB file.
 * @return {YCB} The YCB object.
 */
function makeYCB(config, dimensions, contents) {
    var ycbBundle,
        ycb,
        originalRead,
        originalReadNoMerge;

    ycbBundle = [{dimensions: dimensions}];
    // need to copy contents, since YCB messes with it
    ycbBundle = ycbBundle.concat(clone(contents));
    ycb = new libycb.Ycb(ycbBundle);

    // monkey-patch to apply baseContext
    originalRead = ycb.read;
    ycb.read = function (context, options) {
        return originalRead.call(ycb, config._mergeBaseContext(context), options);
    };
    originalReadNoMerge = ycb.readNoMerge;
    ycb.readNoMerge = function (context, options) {
        return originalReadNoMerge.call(ycb, config._mergeBaseContext(context), options);
    };
    return ycb;
}


/**
 * Create an object that presents the same interface as a YCB object.
 * @private
 * @static
 * @method makeFakeYCB
 * @param {object} dimensions The dimensions definitions.
 * @param {array} contents The contents of the YCB file.
 * @return {YCB} The fake YCB object.
 */
function makeFakeYCB(dimensions, contents) {
    return {
        getDimensions: function () {
            return dimensions;
        },
        walkSettings: function (callback) {
            callback({}, contents);
        },
        read: function () {
            return contents;
        },
        readNoMerge: function () {
            return [contents];
        }
    };
}


/**
 * @class ModownConfig
 * @constructor
 * @param {object} [options] Options for how the configuration files are handled.
 * @param {object} [options.baseContext] Context to apply to all reads.
 * @param {string} [options.dimensionsBundle] Bundle in which to find the dimensions file.
 * See `readDimensions()` for details.
 * @param {string} [options.dimensionsPath] Full path to the dimensions file.
 * See `readDimensions()` for details.
 * The context passed to `read()` will override this on a key-by-key bases.
 */
function Config(options) {
    this._options = options || {};
    this._dimensionsPath = this._options.dimensionsPath;
    this._configPaths = {};     // bundle: config: fullpath
    // cached data:
    this._configYCBs = {};  // fullpath: YCB object
    this._configCache = {}; // bundle: config: context: config
}
Config.prototype = {};


/**
 * Registers a configuration file.
 * @method addConfig
 * @async
 * @param {string} bundleName Name of the bundle to which this config file belongs.
 * @param {string} configName Name of the config file.
 * @param {string} fullPath Full filesystem path to the config file.
 * @return {Promise/A+} A promise that will be fulfilled once the config file is fully registered.
 */
Config.prototype.addConfig = function (bundleName, configName, fullPath) {
    var self = this;
    return this._readConfigContents(fullPath).then(function () {
        // clear old contents (if any)
        self.deleteConfig(bundleName, configName, fullPath);

        if (!self._configPaths[bundleName]) {
            self._configPaths[bundleName] = {};
        }
        self._configPaths[bundleName][configName] = fullPath;

        // keep path to dimensions file up-to-date
        if ('dimensions' === configName && !self._options.dimensionsPath) {
            if (self._options.dimensionsBundle) {
                if (bundleName === self._options.dimensionsBundle) {
                    self._dimensionsPath = fullPath;
                }
            } else {
                if (self._dimensionsPath) {
                    if (fullPath.length < self._dimensionsPath.length) {
                        self._dimensionsPath = fullPath;
                    }
                } else {
                    self._dimensionsPath = fullPath;
                }
            }
        }
    });
};


/**
 * Deregisters a configuration file.
 * @method deleteConfig
 * @param {string} bundleName Name of the bundle to which this config file belongs.
 * @param {string} configName Name of the config file.
 * @param {string} fullPath Full filesystem path to the config file.
 * @return {undefined} Nothing appreciable is returned.
 */
Config.prototype.deleteConfig = function (bundleName, configName, fullPath) {
    if (this._configPaths[bundleName]) {
        this._configPaths[bundleName][configName] = undefined;
    }
};


/**
 * Reads the contents of the named configuration file.
 * This will auto-detect if the configuration file is YCB and read it in a context-sensitive way if so.
 *
 * This can possibly return the configuration object that is stored in a cache, so the caller should
 * copy it if they intend to make a modifications.
 * @method read
 * @async
 * @param {string} bundleName The bundle in which to find the configuration file.
 * @param {string} configName Which configuration to read.
 * @param {object} [context] The runtime context.
 * @return {Promise/A+} A promise that will be fulfilled with the contents of the configuration file.
 */
Config.prototype.read = function (bundleName, configName, context) {
    var self = this;
    
    return this._getConfigCache(bundleName, configName, context, true).then(null, function () {
        return self._getYCB(bundleName, configName).then(function (ycb) {
            return ycb.read(context, {});
        }).then(function (config) {
            return self._setConfigCache(bundleName, configName, context, config, true);
        });
    });
};

/**
 * Reads the contents of the named configuration file and returns the sections
 * appropriate to the context.  The sections are returned in priority order
 * (most important first).
 *
 * If the file is not context sensitive then the list will contain a single section.
 *
 * This can possibly return the configuration object that is stored in a cache, so the caller should
 * copy it if they intend to make a modifications.
 * @method readNoMerge
 * @async
 * @param {string} bundleName The bundle in which to find the configuration file.
 * @param {string} configName Which configuration to read.
 * @param {object} [context] The runtime context.
 * @return {Promise/A+} A promise that will be fulfilled with a prioritized list of sections of the configuration file.
 */
Config.prototype.readNoMerge = function (bundleName, configName, context) {
    var self = this;
    return this._getConfigCache(bundleName, configName, context, false).then(null, function () {
        return self._getYCB(bundleName, configName).then(function (ycb) {
            return ycb.readNoMerge(context, {});
        }).then(function (config) {
            return self._setConfigCache(bundleName, configName, context, config, false);
        });
    });
};

/**
 * Provides a method that should get and return a cached configuration object, 
 * given the bundle name, configuration name, context object, and whether or
 * not the configuration was merged.
 *
 * The default implementation uses the LRU cache from `node-lru-cache`, and options
 * to the cache can be passed through the Config constructor.
 *
 * This can be overridden if a custom caching method is provided.
 * @method _getConfigCache
 * @async
 * @private
 * @param {string} bundleName The bundle in which to find the configuration file.
 * @param {string} configName Which configuration to read.
 * @param {object} context The runtime context.
 * @param {boolean} hasMerge Whether or not the configuration data will be merged.
 * @return {Promise/A+} A promise that will be fulfilled with either the merged or unmerged
    cached configuration data, or rejected with the reason it is not in the cache.
 */
Config.prototype._getConfigCache = function (bundleName, configName, context, hasMerge) {
    var self = this,
        bundlePath,
        configPath,
        mergePath,
        mergeName = hasMerge ? 'merge' : 'no-merge',
        config;

    bundlePath = self._configCache[bundleName];
    if (!bundlePath) {
        return Promise.reject(new Error(util.format(MESSAGES['unknown bundle'], bundleName)));
    }

    configPath = bundlePath[configName];
    if (!configPath) {
        return Promise.reject(new Error(util.format(MESSAGES['unknown config'], configName, bundleName)));
    }

    mergePath = configPath[mergeName];
    if (!mergePath) {
        return Promise.reject(new Error(util.format(MESSAGES['unknown cache data'], configName, bundleName)));
    }

    config = mergePath.get(getCacheKey(context));
    if (config) {
        return Promise.resolve(config);
    }
    return Promise.reject(new Error(util.format(MESSAGES['unknown cache data'], configName, bundleName)));   
};

/**
 * Provides a method that should set and return a cached configuration object, 
 * given the bundle name, configuration name, context object, configuration,
 * and whether or not it was merged.
 *
 * The default implementation uses the LRU cache from `node-lru-cache`, and options
 * to the cache can be passed through the Config constructor.
 *
 * This can be overridden if a custom caching method is provided.
 * @method _setConfigCache
 * @async
 * @private
 * @param {string} bundleName The bundle in which to find the configuration file.
 * @param {string} configName Which configuration to read.
 * @param {object} context The runtime context.
 * @param {object} config The configuration data.
 * @param {boolean} hasMerge Whether or not the configuration data will be merged.
 * @return {Promise/A+} A promise that will be fulfilled with either the merged or unmerged
    cached configuration data, or rejected with the reason it is not in the cache.
 */
Config.prototype._setConfigCache = function (bundleName, configName, context, config, hasMerge) {
    var self = this,
        LRU  = libcache,
        mergeName = hasMerge ? 'merge' : 'no-merge',
        cacheOptions = self._options.cache || DEFAULT_CACHE_OPTIONS,
        bundlePath,
        configPath,
        cache,
        configCache = self._configCache;

    bundlePath = configCache[bundleName] = (configCache[bundleName] || {});
    configPath = bundlePath[configName] = (bundlePath[configName] || {});
    cache      = configPath[mergeName] = (configPath[mergeName] || new LRU(cacheOptions));

    cache.set(getCacheKey(context), config);

    return Promise.resolve(config);
};

/**
 * Reads the dimensions file for the application.
 *
 * If `options.dimensionsPath` is given to the constructor that'll be used.
 * Otherwise, the dimensions file found in `options.dimensionsBundle` will be used.
 * Otherwise, the dimensions file with the shortest path will be used.
 *
 * The returned dimensions object is shared, so it should not be modified.
 * @method readDimensions
 * @return {Promise/A+} A promise that will be fulfilled with the dimensions.
 */
Config.prototype.readDimensions = function () {
    var self = this;
    if (!self._dimensionsPath) {
        return Promise.reject(new Error(MESSAGES['missing dimensions']));
    }
    if (self._cachedDimensions) {
        return Promise.resolve(self._cachedDimensions);
    }
    return self._readConfigContents(self._dimensionsPath).then(function (body) {
        self._cachedDimensions = body[0].dimensions;
        return self._cachedDimensions;
    });
};


/**
 * Promises a YCB object for the configuration file.
 * This returns a YCB object even if the configuration file isn't a YCB file.
 * @private
 * @method _getYCB
 * @async
 * @param {string} bundleName The bundle in which to find the configuration file.
 * @param {string} configName Which configuration to read.
 * @param {object} [context] The runtime context.
 * @return {Promise/A+} A promise that will be fulfilled with the YCB object.
 */
Config.prototype._getYCB = function (bundleName, configName) {
    var self = this;
        var path,
            contents,
            isYCB;

    if (!self._configPaths[bundleName]) {
        return Promise.reject(new Error(util.format(MESSAGES['unknown bundle'], bundleName)));
    }
    path = self._configPaths[bundleName][configName];
    if (!path) {
        return Promise.reject(new Error(util.format(MESSAGES['unknown config'], configName, bundleName)));
    }

    if (self._configYCBs[path]) {
        return Promise.resolve(self._configYCBs[path]);
    }

    return self._readConfigContents(path).then(function (c) {
        contents = c;
        isYCB = contentsIsYCB(contents);
        if (isYCB) {
            return self.readDimensions();
        }
    }).then(function (dimensions) {
        var ycb;
        if (isYCB) {
            ycb = makeYCB(self, dimensions, contents);
        } else {
            ycb = makeFakeYCB(dimensions, contents);
        }
        self._configYCBs[path] = ycb;
        return ycb;
    });
};


/**
 * Reads the contents of a configuration file.
 * @private
 * @method _readConfigContents
 * @async
 * @param {string} path Full path to the file.
 * @return {Promise/A+} A promise that will be fulfilled with the contents of the file.
 */
Config.prototype._readConfigContents = function (path) {
    var self = this;
    return new Promise(function (resolve, reject) {
        var ext = libpath.extname(path),
            contents;
        // really try to do things async as much as possible
        if ('.json' === ext || '.json5' === ext || '.yaml' === ext || '.yml' === ext) {
            libfs.readFile(path, 'utf8', function (err, contents) {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    if ('.json' === ext) {
                        contents = JSON.parse(contents);
                    } else if ('.json5' === ext) {
                        contents = libjson5.parse(contents);
                    } else {
                        contents = libyaml.parse(contents);
                    }
                    resolve(contents);
                } catch (e) {
                    reject(new Error(util.format(MESSAGES['parse error'], path, e.message)));
                }
            });
        } else {
            try {
                contents = require(path);
                resolve(contents);
            } catch (e) {
                reject(new Error(util.format(MESSAGES['parse error'], path, e.message)));
            }
        }
    });
};


/**
 * Merges the base context under the runtime context.
 * @private
 * @method _mergeBaseContext
 * @param {object} context The runtime context.
 * @return {object} A new object with the context expanded with the base merged under.
 */
Config.prototype._mergeBaseContext = function (context) {
    return mix(clone(context), this._options.baseContext);
};


module.exports = Config;


Config.test = {
    contentsIsYCB: contentsIsYCB,
    makeYCB: makeYCB,
    makeFakeYCB: makeFakeYCB
};
