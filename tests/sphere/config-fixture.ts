import type { SphereSettings } from '../../src/emulators/sphere/config';
import { sphereSources } from '../../src/emulators/sphere/source';
import type { InstanceFiles } from '../../src/instance';

export const sphereSettings: SphereSettings = {
  scriptsSource: { ...sphereSources.scripts, revision: 'b'.repeat(40) },
  autoCreateAccounts: false,
  clientEncryption: 'encrypted',
  owner: 'admin',
  maps: 'expansion',
  mapSize: 'modern'
};

export function sphereFixture(): InstanceFiles {
  const fields = {
    ServName: 'MyShard',
    ServIP: '127.0.0.1',
    ServPort: '2593',
    UseCrypt: '1',
    UseNoCrypt: '0',
    TimeZone: '0',
    AdminEmail: 'me@my.email.com',
    URL: 'www.myshard.com',
    ScpFiles: 'scripts/',
    WorldSave: 'save/',
    AcctFiles: 'accounts/',
    Log: 'logs/',
    AutoAccountCreation: '0',
    Md5Passwords: '0',
    SavePeriod: '20',
    MySQL: '0',
    FeatureT2A: '01|02',
    FeatureLBR: '0',
    FeatureAOS: '0',
    FeatureSE: '0',
    FeatureML: '0',
    FeatureKR: '0',
    FeatureSA: '0',
    FeatureTOL: '0',
    FeatureExtra: '0',
    OptionFlags: '01|08|020|0200|0800|02000|020000',
    Experimental: '0',
    CombatFlags: '0',
    CombatArcheryMovementDelay: '10',
    CombatDamageEra: '0',
    CombatHitChanceEra: '0',
    CombatSpeedEra: '0',
    SpeedScaleFactor: '15000',
    MagicFlags: '0',
    RacialFlags: '0',
    RevealFlags: '01|02|04|08|010',
    NPCAI: '0',
    Map0: '7168,4096,-1,0,0',
    Map1: '7168,4096,-1,1,1',
    Map2: '2304,1600,-1,2,2',
    Map3: '2560,2048,-1,3,3',
    Map4: '1448,1448,-1,4,4',
    Map5: '1280,4096,-1,5,5'
  };
  const files: InstanceFiles = {
    'sphere.ini': `[SPHERE]\r\n${Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join('\r\n')}\r\n//MulFiles=mul/\r\n[SERVERS]\r\nMyShard\r\n127.0.0.1\r\n2593\r\n[EOF]\r\n`,
    'sphereCrypt.ini': new Uint8Array([0x2f, 0x2f, 0xe9, 0x0d, 0x0a]),
    'scripts/spheretables.scp': '[RESOURCES]\r\nscripts/sphere_defs.scp\r\n',
    'scripts/sphere_defs.scp': Buffer.from('// unchanged \xe9\r\n', 'latin1'),
    'scripts/adddialog.db': new Uint8Array([0, 0xff, 0x80, 0x42])
  };
  for (let map = 0; map < 6; map++) {
    for (const kind of ['map', 'map_points']) {
      const filename = `scripts/maps/sphere_${kind}${map}.scp`;
      files[filename] = '// fixture\r\n';
      files['scripts/spheretables.scp'] += `${filename}\r\n`;
    }
  }
  return files;
}
