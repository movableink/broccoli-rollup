import {
  createBuilder,
  createTempDir,
  Disposable,
  TempDir,
} from 'broccoli-test-helper';
import { resolve } from 'path';
import Rollup = require('../index');
import { IRollupOptions } from '../lib/rollup';
// tslint:disable-next-line:no-var-requires
const mergeTrees: (input: any[]) => any = require('broccoli-merge-trees');
const describe = QUnit.module;
const it = QUnit.test;

// tslint:disable:max-line-length

describe('Staging files smoke tests', () => {
  it('handles merged trees and building from staging', async assert => {
    await using(async use => {
      const input1 = use(await createTempDir());
      const input2 = use(await createTempDir());
      const node = new Rollup(mergeTrees([input1.path(), input2.path()]), {
        rollup: {
          input: 'index.js',
          output: {
            file: 'out.js',
            format: 'es',
          },
        },
      });
      const output = use(createBuilder(node));

      input1.write({
        'add.js': 'export const add = num => num++;',
        'index.js':
          'import two from "./two"; import { add } from "./add"; const result = add(two); export default result;',
        node_modules: {},
      });

      input2.write({
        'minus.js': 'export const minus = num => num--;',
        'two.js':
          'import { minus } from "./minus"; const two = minus(3); export default two;',
      });

      await output.build();

      assert.deepEqual(output.read(), {
        'out.js':
          'const minus = num => num--;\n\nconst two = minus(3);\n\nconst add = num => num++;\n\nconst result = add(two);\n\nexport default result;\n',
      });
    });
  });
});

describe('BroccoliRollup', () => {
  it('test build: initial update noop', async assert => {
    await using(async use => {
      const input = use(await createTempDir());
      const subject = new Rollup(input.path(), {
        rollup: {
          input: 'index.js',
          output: {
            file: 'out.js',
            format: 'es',
          },
        },
      });
      const output = use(createBuilder(subject));
      // INITIAL
      input.write({
        'add.js': 'export default x => x + x;',
        'index.js':
          'import add from "./add"; const two = add(1); export default two;',
      });
      await output.build();

      assert.deepEqual(output.read(), {
        'out.js': `var add = x => x + x;

const two = add(1);

export default two;
`,
      });
      assert.deepEqual(output.changes(), {
        'out.js': 'create',
      });

      // UPDATE
      input.write({
        'minus.js': `export default x => x - x;`,
      });
      await output.build();

      assert.deepEqual(output.read(), {
        'out.js': `var add = x => x + x;

const two = add(1);

export default two;
`,
      });
      assert.deepEqual(output.changes(), {});

      input.write({
        'index.js':
          'import add from "./add"; import minus from "./minus"; export default { a: add(1), b: minus(1) };',
      });

      await output.build();

      assert.deepEqual(output.read(), {
        'out.js': `var add = x => x + x;

var minus = x => x - x;

var index = { a: add(1), b: minus(1) };

export default index;
`,
      });
      assert.deepEqual(output.changes(), {
        'out.js': 'change',
      });

      input.write({ 'minus.js': null });

      let errorWasThrown = false;
      try {
        await output.build();
      } catch (e) {
        errorWasThrown = true;
        assert.ok(e.message.startsWith('Could not load'));
      }
      assert.ok(errorWasThrown);

      input.write({
        'index.js': 'import add from "./add"; export default add(1);',
      });

      await output.build();

      assert.deepEqual(output.read(), {
        'out.js': `var add = x => x + x;

var index = add(1);

export default index;
`,
      });
      assert.deepEqual(output.changes(), {
        'out.js': 'change',
      });

      // NOOP
      await output.build();

      assert.deepEqual(output.changes(), {});
    });
  });

  describe('sourcemaps', () => {
    it('creates sourcemaps', async assert => {
      await using(async use => {
        const input = use(await createTempDir());
        const subject = new Rollup(input.path(), {
          rollup: {
            input: 'index.js',
            output: {
              file: 'out.js',
              format: 'es',
              sourcemap: true
            },
          },
        });
        const output = use(createBuilder(subject));
        // INITIAL
        input.write({
          'add.js': 'export default x => x + x;',
          'index.js':
          'import add from "./add"; const two = add(1); export default two;',
        });
        await output.build();

        assert.deepEqual(output.read(), {
          'out.js': `var add = x => x + x;

const two = add(1);

export default two;
//# sourceMappingURL=out.js.map`,
          'out.js.map': `{\"version\":3,\"file\":\"out.js\",\"sources\":[\"add.js\",\"index.js\"],\"sourcesContent\":[\"export default x => x + x;\",\"import add from \\\"./add\\\"; const two = add(1); export default two;\"],\"names\":[],\"mappings\":\"AAAA,UAAe,CAAC,IAAI,CAAC,GAAG,CAAC;;qBAAC,rBCAD,MAAM,GAAG,GAAG,GAAG,CAAC,CAAC,CAAC,CAAC;;;;\"}`,
        });
        assert.deepEqual(output.changes(), {
          'out.js': 'create',
          'out.js.map': 'create',
        });
      });
    });
  });

  describe('targets', hooks => {
    let input: TempDir;
    hooks.beforeEach(async () => {
      input = await createTempDir();
      input.write({
        'add.js': 'export default x => x + x;',
        'index.js':
          'import add from "./add"; const two = add(1); export default two;',
      });
    });

    hooks.afterEach(async () => {
      await input.dispose();
    });

    // supports multiple targets
    it('works with one explicit target', async assert => {
      const node = new Rollup(input.path(), {
        rollup: {
          input: 'index.js',
          output: {
            file: 'dist/out.umd.js',
            format: 'umd',
            name: 'thing',
          },
        },
      });
      const output = createBuilder(node);
      try {
        await output.build();

        assert.deepEqual(output.read(), {
          dist: {
            'out.umd.js': `(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
	typeof define === 'function' && define.amd ? define(factory) :
	(global.thing = factory());
}(this, (function () { 'use strict';

	var add = x => x + x;

	const two = add(1);

	return two;

})));
`,
          },
        });
      } finally {
        await output.dispose();
      }
    });
  });

  describe('passing nodeModulesPath', () => {
    it('should throw if nodeModulesPath is relative', assert => {
      assert.throws(
        () =>
          new Rollup('lib', {
            nodeModulesPath: './',
            rollup: {
              input: 'index.js',
              output: {
                file: 'out.js',
                format: 'es',
              },
            },
          }),
        new Error(
          'nodeModulesPath must be fully qualified and you passed a relative path',
        ),
      );
    });

    it('accepts multiple nodeModulesPath entries', async (assert) => {
      await using(async use => {
        const input = use(await createTempDir());

        const subject = new Rollup(input.path(), {
          nodeModulesPath: [
            input.path('./a/node_modules'),
            input.path('./node_modules')
          ],
          rollup: {
            input: 'index.js',
            output: {
              file: 'out.js',
              format: 'es'
            },
          },
        });

        const output = use(createBuilder(subject));

        input.write({
          'index.js': `
import a from '../../node_modules/x-module-a/index';
import b from '../node_modules/x-module-b/index';
const c = a + b;
export default c;`,
          a: {
            node_modules: {
              'x-module-a': {
                'index.js': "export default 1;"
              }
            }
          },
          node_modules: {
            'x-module-b': {
              'index.js': "export default 2;"
            }
          }
        });

        try {
          await output.build();

          assert.deepEqual(output.read(), {
            'out.js': "var a = 1;\n\nvar b = 2;\n\nconst c = a + b;\n\nexport default c;\n"
          });
        } finally {
          await output.dispose();
        }
      });
    });
  });

  describe('tree shaking', () => {
    it('can code split', async assert => {
      await using(async use => {
        const input = use(await createTempDir());
        const subject = new Rollup(input.path(), {
          rollup: {
            experimentalCodeSplitting: true,
            input: ['a.js', 'b.js'],
            output: {
              dir: 'chunks',
              format: 'es',
            },
          },
        });

        const output = use(createBuilder(subject));

        input.write({
          'a.js':
            'import c from "./c"; import e from "./e"; export const out = c + e;',
          'b.js':
            'import d from "./d";import e from "./e"; export const out = d + e;',
          'c.js': 'const num1 = 1; export default num1;',
          'd.js': 'const num2 = 2; export default num2;',
          'e.js': 'const num3 = 3; export default num3;',
        });

        await output.build();

        assert.deepEqual(output.read(), {
          chunks: {
            'a.js': `import { a as e } from './chunk-53cd0688.js';

const num1 = 1;

const out = num1 + e;

export { out };
`,
            'b.js': `import { a as e } from './chunk-53cd0688.js';

const num2 = 2;

const out = num2 + e;

export { out };
`,
            'chunk-53cd0688.js': `const num3 = 3;

export { num3 as a };
`,
          },
        });
      });
    });
  });
});

type UseCallback = <T extends Disposable>(disposable: T) => T;

// tslint:disable:no-conditional-assignment
async function using(body: (use: UseCallback) => Promise<void>) {
  const disposables: Disposable[] = [];
  const use: UseCallback = disposable => {
    disposables.push(disposable);
    return disposable;
  };
  try {
    await body(use);
  } finally {
    let disposable;
    while ((disposable = disposables.pop())) {
      await disposable.dispose();
    }
  }
}
