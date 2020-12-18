/******************************************************************************/
/*
 * Copyright 2012-2016 AOL Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this Software except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const fs = require('fs');
const csv = require('csv');
const WISESource = require('./wiseSource.js');

class AlienVaultSource extends WISESource {
  // ----------------------------------------------------------------------------
  constructor (api, section) {
    super(api, section, { dontCache: true });
    this.key = api.getConfig('alienvault', 'key');

    if (this.key === undefined) {
      console.log(this.section, '- No export key defined');
      return;
    }
    this.ips = new Map();

    this.api.addSource('alienvault', this);

    this.idField = this.api.addField('field:alienvault.id;db:alienvault.id;kind:integer;friendly:Id;help:Alien Vault ID;count:true');
    this.reliabilityField = this.api.addField('field:alienvault.reliability;db:alienvault.reliability;kind:integer;friendly:Reliability;help:Alien Vault Reliability;count:true');
    this.threatlevelField = this.api.addField('field:alienvault.threat-level;db:alienvault.threatlevel;kind:integer;friendly:Threat Level;help:Alien Vault Threat Level;count:true');
    this.activityField = this.api.addField('field:alienvault.activity;db:alienvault.activity;kind:termfield;friendly:Activity;help:Alien Vault Activity;count:true');

    this.api.addView('alienvault',
      'if (session.alienvault)\n' +
      '  div.sessionDetailMeta.bold AlienVault\n' +
      '  dl.sessionDetailMeta\n' +
      "    +arrayList(session.alienvault, 'activity', 'Activity', 'alienvault.activity')\n" +
      "    +arrayList(session.alienvault, 'threatlevel', 'Threat Level', 'alienvault.threat-level')\n" +
      "    +arrayList(session.alienvault, 'reliability', 'Reliability', 'alienvault.reliability')\n" +
      "    +arrayList(session.alienvault, 'id', 'Id', 'alienvault.id')\n"
    );

    setImmediate(this.loadFile.bind(this));
    setInterval(this.loadFile.bind(this), 2 * 60 * 60 * 1000); // Reload file every 2 hours
  }

  // ----------------------------------------------------------------------------
  parseFile () {
    const parser = csv.parse({ delimiter: '#', skip_empty_lines: true }, (err, data) => {
      if (err) {
        console.log(this.section, "- Couldn't parse csv", err);
        return;
      }
      let count = 0;
      this.ips.clear();
      for (let i = 0; i < data.length; i++) {
        if (data[i].length < 8) {
          continue;
        }

        const encoded = WISESource.encodeResult(
          this.idField, data[i][7],
          this.reliabilityField, data[i][1],
          this.threatlevelField, data[i][2],
          this.activityField, data[i][3]
        );
        this.ips.set(data[i][0], encoded);
        count++;
      }
      console.log(this.section, '- Done Loading', count, 'elements');
    });
    fs.createReadStream('/tmp/alienvault.data').pipe(parser);
  };

  // ----------------------------------------------------------------------------
  loadFile () {
    console.log(this.section, '- Downloading files');

    let revision = -1;

    // If we already have the rev and data files, find out what revision the data file is
    if (fs.existsSync('/tmp/alienvault.rev') && fs.existsSync('/tmp/alienvault.data')) {
      revision = +fs.readFileSync('/tmp/alienvault.rev').toString();
    }

    // Get the new revision
    WISESource.request('https://reputation.alienvault.com/' + this.key + '/reputation.rev', '/tmp/alienvault.rev', (statusCode) => {
      // If statusCode isn't success or not changed then try again if not already
      if (statusCode !== 200 && statusCode !== 304) {
        if (!this.retry) {
          this.retry = setTimeout(this.loadFile.bind(this), 5 * 60 * 1000);
        }
        return;
      }

      const line = fs.readFileSync('/tmp/alienvault.rev').toString();

      // New revision doesn't match old revision, need new data file
      if (+line !== revision) {
        // Remove old data file since out of date
        if (fs.existsSync('/tmp/alienvault.data')) {
          fs.unlinkSync('/tmp/alienvault.data');
        }

        // Fetch new data file
        WISESource.request('https://reputation.alienvault.com/' + this.key + '/reputation.data', '/tmp/alienvault.data', (statusCode) => {
          if (statusCode === 200) {
            this.loaded = true;
            this.parseFile();
            delete this.retry;
          } else {
            if (!this.retry) {
              this.retry = setTimeout(this.loadFile.bind(this), 5 * 60 * 1000); // Failed to load data file, try again in 5 minutes
            }
          }
        });

      // We haven't loaded anything, if revision isn't -1 then we have a rev and data file
      } else if (!this.loaded && revision !== -1) {
        this.loaded = true;
        this.parseFile();
        delete this.retry;
      }
    });
  };

  // ----------------------------------------------------------------------------
  getIp (ip, cb) {
    cb(null, this.ips.get(ip));
  };
  // ----------------------------------------------------------------------------
  dump (res) {
    this.ips.forEach((value, key) => {
      const str = '{key: "' + key + '", ops:\n' +
                 WISESource.result2JSON(value) + '},\n';
      res.write(str);
    });
    res.end();
  };
}
// ----------------------------------------------------------------------------
exports.initSource = function (api) {
  api.addSourceConfigDef('alienvault', {
    singleton: true,
    name: 'alienvault',
    description: 'Link to the alienvault data',
    types: ['ip'],
    cacheable: false,
    fields: [
      { name: 'key', password: true, required: true, help: 'The API key' }
    ]
  });

  return new AlienVaultSource(api, 'alienvault');
};
