import {
  constants as fsConstants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  realpathSync,
} from 'fs';
import * as path from 'path';
import {
  InputOption,
  OutputOptions,
  RollupBuild,
  RollupSingleFileBuild,
} from 'rollup';
import { instrument, logger } from './lib/heimdall';
import OutputPatcher from './lib/output-patcher';
import Plugin from './lib/plugin';
import resolver from './lib/resolver';
import {
  IGeneratedResult,
  IRollupOptions,
  isSingleFileBuild,
  RollupFunc,
} from './lib/rollup';
import { ITree, treeFromEntries, treeFromPath } from './lib/tree-diff';

// tslint:disable:no-var-requires
const symlinkOrCopySync: (
  src: string,
  dst: string,
) => void = require('symlink-or-copy').sync;
const nodeModulesPath: (cwd: string) => string = require('node-modules-path');
// tslint:enable:no-var-requires

const deref =
  typeof copyFileSync === 'function'
    ? (srcPath: string, destPath: string) => {
        try {
          unlinkSync(destPath);
        } catch (e) {
          if (e.code !== 'ENOENT') {
            throw e;
          }
        }
        copyFileSync(srcPath, destPath, fsConstants.COPYFILE_EXCL);
      }
    : (srcPath: string, destPath: string) => {
        const content = readFileSync(srcPath);
        writeFileSync(destPath, content);
      };

export = class Rollup extends Plugin {
  public rollupOptions: IRollupOptions;
  public cache: boolean;
  public innerCachePath = '';
  public nodeModulesPaths: Array<string>;

  private _lastChunk: RollupBuild | RollupSingleFileBuild | null;
  private lastTree: ITree;
  private _output: OutputPatcher | null;

  constructor(
    node: any,
    options: {
      annotation?: string;
      name?: string;
      rollup: IRollupOptions;
      cache?: boolean;
      nodeModulesPath?: string | Array<string>;
    },
  ) {
    super([node], {
      annotation: options.annotation,
      name: options.name,
      persistentOutput: true,
    });
    this.rollupOptions = options.rollup;
    this._lastChunk = null;
    this._output = null;
    this.lastTree = treeFromEntries([]);
    this.cache = options.cache === undefined ? true : options.cache;

    if (Array.isArray(options.nodeModulesPath)) {
      this.nodeModulesPaths = options.nodeModulesPath;
    } else if (typeof options.nodeModulesPath === 'string') {
      this.nodeModulesPaths = [options.nodeModulesPath];
    } else {
      this.nodeModulesPaths = [nodeModulesPath(process.cwd())];
    }

    if (
      this.nodeModulesPaths !== undefined &&
        !this.nodeModulesPaths.every(p => path.isAbsolute(p))
    ) {
      throw new Error(
        `nodeModulesPath must be fully qualified and you passed a relative path`,
      );
    }
  }

  public build() {
    const lastTree = this.lastTree;

    if (!this.innerCachePath) {
      // If passed multiple nodeModulesPaths, we need to build a hierarchy so
      // that the resolution works properly. For instance, if we had 3 node_modules
      // directories passed to us, we would have the following directory structure:
      //
      //   ${this.cachePath}/node_modules
      //   ${this.cachePath}/0/node_modules
      //   ${this.cachePath}/0/1/node_modules
      //   ${this.cachePath}/0/1/build/index.js
      //
      let innerCachePath = this.cachePath;
      this.nodeModulesPaths.forEach((path, index) => {
        symlinkOrCopySync(path, `${innerCachePath}/node_modules`);
        const dir = (index === this.nodeModulesPaths.length - 1) ? 'build' : `${index}`;
        mkdirSync((innerCachePath = `${innerCachePath}/${dir}`));
      });
      this.innerCachePath = innerCachePath;
    }

    this.innerCachePath = realpathSync(this.innerCachePath);

    const newTree = (this.lastTree = treeFromPath(this.inputPaths[0]));
    const patches = lastTree.calculatePatch(newTree);

    patches.forEach(change => {
      const op = change[0];
      const relativePath = change[1];
      switch (op) {
        case 'mkdir':
          mkdirSync(`${this.innerCachePath}/${relativePath}`);
          break;
        case 'unlink':
          unlinkSync(`${this.innerCachePath}/${relativePath}`);
          break;
        case 'rmdir':
          rmdirSync(`${this.innerCachePath}/${relativePath}`);
          break;
        case 'create':
          deref(
            `${this.inputPaths[0]}/${relativePath}`,
            `${this.innerCachePath}/${relativePath}`,
          );
          break;
        case 'change':
          deref(
            `${this.inputPaths[0]}/${relativePath}`,
            `${this.innerCachePath}/${relativePath}`,
          );
          break;
      }
    });

    // If this a noop post initial build, just bail out
    if (this._lastChunk && patches.length === 0) {
      return;
    }

    const options = this._loadOptions();
    options.input = this._mapInput(options.input);
    const heimdall = instrument('rollup');

    const rollup: RollupFunc = require('rollup').rollup;
    return rollup(options)
      .then((chunk: RollupSingleFileBuild | RollupBuild) => {
        if (this.cache) {
          this._lastChunk = chunk;
        }
        return this._buildTargets(chunk, options);
      }).then((targets) => {
        heimdall.stop();
        return targets;
      }).catch((e) => {
        heimdall.stop();
        throw(e);
      });
  }

  private _mapInput(input: InputOption) {
    if (Array.isArray(input)) {
      return input.map(entry => `${this.innerCachePath}/${entry}`);
    }

    return `${this.innerCachePath}/${input}`;
  }

  private _loadOptions(): IRollupOptions {
    // TODO: support rollup config files
    const options = Object.assign(
      {
        cache: this._lastChunk,
      },
      this.rollupOptions,
    );
    return options;
  }

  private async _buildTargets(chunk: RollupBuild | RollupSingleFileBuild, options: IRollupOptions) {
    const output = this._getOutput();
    await this._buildTarget(chunk, output, options.output);
    output.patch();
  }

  private async _buildTarget(
    chunk: RollupBuild | RollupSingleFileBuild,
    output: OutputPatcher,
    options: OutputOptions = {},
  ) {
    if (isSingleFileBuild(chunk)) {
      const generateOptions = this._generateSourceMapOptions(options);
      const result = await chunk.generate(generateOptions);
      this._writeFile(options.file!, options.sourcemap!, result, output);
    } else {
      const results = (await chunk.generate(
        Object.assign({}, options, {
          sourcemap: !!options.sourcemap,
        }),
      ));
      Object.keys(results.output).forEach(file => {
        const fileName = resolver.moduleResolve(`./${file}`, options.dir! + '/');
        this._writeFile(
          fileName,
          options.sourcemap!,
          results.output[file] as IGeneratedResult,
          output,
        );
      });
    }
  }

  private _generateSourceMapOptions(options: OutputOptions = {}): OutputOptions {
    const sourcemap = options.sourcemap;
    const file = options.file;
    const sourcemapFile = options.sourcemapFile;
    if (sourcemapFile) {
      options.sourcemapFile = this.innerCachePath + '/' + sourcemapFile;
    } else {
      options.sourcemapFile = this.innerCachePath + '/' + file;
    }

    return Object.assign({}, options, {
      sourcemap: !!sourcemap,
    });
  }

  private _writeFile(
    filePath: string,
    sourcemap: boolean | 'inline' | undefined,
    result: IGeneratedResult,
    output: OutputPatcher,
  ) {
    let code = result.code;
    const map = result.map;
    if (sourcemap && map !== null) {
      let url;
      if (sourcemap === 'inline' && map) {
        url = map.toUrl();
      } else {
        url = this._addSourceMap(map, filePath, output);
      }
      code += '//# sourceMap';
      code += `pingURL=${url}`;
    }

    output.add(filePath, code);
  }

  private _addSourceMap(map: any, relativePath: string, output: OutputPatcher) {
    const url = path.basename(relativePath) + '.map';
    output.add(relativePath + '.map', map.toString());
    return url;
  }

  private _getOutput() {
    let output = this._output;
    if (!output) {
      output = this._output = new OutputPatcher(this.outputPath, logger);
    }
    return output;
  }
};
