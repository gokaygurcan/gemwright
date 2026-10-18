import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as prompts from '@clack/prompts';

import { expansions, type ShardConfig } from '../../config';
import { answer } from '../../prompts';
import { generatedOwnerPassword, validateOwnerPassword } from '../accounts';
import {
  fetchSphereFiles,
  prepareSphereFiles,
  type SphereSettings,
  sphereConfigValue,
  sphereMapCount,
  validateSphereOwner
} from './config';
import { askSphereRules } from './rules-prompts';
import type { SphereSources } from './source';

export async function initializeSphere(
  config: ShardConfig,
  sources: SphereSources,
  yes = false,
  loadFiles = fetchSphereFiles
) {
  let generatedPassword: string | undefined;

  const upstream = await loadFiles(sources);
  const ini = upstream['sphere.ini'];
  if (ini === undefined) throw new Error('Missing upstream sphere.ini.');
  const iniText = typeof ini === 'string' ? ini : Buffer.from(ini).toString('latin1');
  const useCrypt = sphereConfigValue(iniText, 'UseCrypt');
  const useNoCrypt = sphereConfigValue(iniText, 'UseNoCrypt');
  if (
    !['0', '1'].includes(useCrypt ?? '') ||
    !['0', '1'].includes(useNoCrypt ?? '') ||
    (useCrypt === '0' && useNoCrypt === '0')
  )
    throw new Error('Upstream Sphere encryption defaults are missing or invalid.');
  const defaultEncryption = useCrypt === '0' ? 'unencrypted' : useNoCrypt === '0' ? 'encrypted' : 'both';
  const registration = sphereConfigValue(
    typeof ini === 'string' ? ini : Buffer.from(ini).toString('latin1'),
    config.emulator === 'sphere-x' ? 'AccApp' : 'AutoAccountCreation'
  );
  if (!(config.emulator === 'sphere-x' ? ['0', '2'] : ['0', '1']).includes(registration ?? ''))
    throw new Error('Upstream Sphere registration default is missing or invalid.');
  if (!yes)
    prompts.note(
      'Expansion sets client features. Combat and other rules can be customized below; Enter keeps upstream rule defaults.',
      'Sphere'
    );
  const clientFiles = yes
    ? ''
    : answer(
        await prompts.text({
          message: 'UO client files directory (optional; leave blank to add at deploy)',
          validate: async (value) => {
            if (!value) return;
            try {
              if (!(await stat(resolve(value))).isDirectory()) return 'Choose a directory.';
            } catch {
              return 'That directory does not exist.';
            }
          }
        })
      );
  const clientEncryption: NonNullable<SphereSettings['clientEncryption']> = yes
    ? defaultEncryption
    : answer(
        await prompts.select({
          message: 'Client encryption',
          initialValue: defaultEncryption,
          options: [
            { value: 'encrypted' as const, label: 'Encrypted clients only' },
            {
              value: 'both' as const,
              label: 'Encrypted and unencrypted clients',
              hint: 'Allows ClassicUO with encryption off'
            },
            { value: 'unencrypted' as const, label: 'Unencrypted clients only' }
          ]
        })
      );
  const maps: SphereSettings['maps'] =
    yes || sphereMapCount(config.expansion) === 1
      ? 'expansion'
      : answer(
          await prompts.select({
            message: 'World maps',
            initialValue: 'expansion',
            options: [
              { value: 'expansion' as const, label: 'All maps through the selected expansion' },
              { value: 'felucca' as const, label: 'Felucca only' }
            ]
          })
        );
  const mapSize: SphereSettings['mapSize'] =
    yes ||
    expansions.findIndex((entry) => entry.value === config.expansion) >=
      expansions.findIndex((entry) => entry.value === 'ml')
      ? 'modern'
      : answer(
          await prompts.select({
            message: 'Which UO map files will you use?',
            initialValue: 'modern',
            options: [
              {
                value: 'modern' as const,
                label: "Mondain's Legacy or newer",
                hint: '7168 × 4096 Felucca/Trammel terrain'
              },
              {
                value: 'legacy' as const,
                label: "Before Mondain's Legacy",
                hint: '6144 × 4096 Felucca/Trammel terrain'
              }
            ]
          })
        );
  const rules = config.emulator === 'sphere-x' ? undefined : await askSphereRules(iniText, yes);
  const autoCreateAccounts = yes
    ? registration === (config.emulator === 'sphere-x' ? '2' : '1')
    : answer(
        await prompts.confirm({
          message: 'Allow players to create accounts on first login?',
          initialValue: registration === (config.emulator === 'sphere-x' ? '2' : '1')
        })
      );
  const owner = yes
    ? 'admin'
    : answer(
        await prompts.text({
          message: 'Owner username',
          placeholder: 'admin',
          defaultValue: 'admin',
          validate: (value) => validateSphereOwner(value || 'admin')
        })
      );
  let password = yes
    ? ''
    : answer(
        await prompts.password({
          message: 'Owner password (leave blank to generate)',
          validate: (value) => validateOwnerPassword(value ?? '')
        })
      );
  if (!password) password = generatedPassword = generatedOwnerPassword();
  const settings: SphereSettings = {
    scriptsSource: sources.scripts,
    ...(clientFiles ? { clientFiles: resolve(clientFiles) } : {}),
    autoCreateAccounts,
    clientEncryption,
    owner,
    maps,
    mapSize,
    rules
  };
  return { settings, files: prepareSphereFiles(upstream, config, settings, password), generatedPassword };
}
