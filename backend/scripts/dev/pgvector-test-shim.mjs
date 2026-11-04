/**
 * Test-only stand-in for the `vector` extension (pgvector), installed into the embedded Postgres that the unit suites and the e2e stack
 * start. The embedded binaries ship without pgvector, and production's migration (0072) runs `CREATE EXTENSION vector`; with this shim
 * the same migration runs unchanged on the embedded cluster. Runs from the root `postinstall`; exits quietly when embedded-postgres
 * is not installed (a production `pnpm install --prod`).
 *
 * What the shim is: a `vector(n)` type stored as text ('[1,2,3]'), the `<=>` cosine-distance operator in plain SQL, and an `hnsw` index
 * method with the `vector_cosine_ops` class that is really a btree. It answers the same queries as pgvector, exactly and slowly, and
 * uses no ANN index. What the real extension does (HNSW plans, iterative scans, dimension checks) is covered by
 * packages/memory-graph/src/__tests__/pgvector.real.test.ts, which runs against PGVECTOR_TEST_URL (a real pgvector) and is skipped without it.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.0.1';

const CONTROL = `comment = 'TEST-ONLY stand-in for pgvector (pure SQL, no ANN index); never installed in production'
default_version = '${VERSION}'
relocatable = false
superuser = true
`;

const SCRIPT = `
CREATE TYPE vector;
CREATE FUNCTION vector_in(cstring) RETURNS vector AS 'textin' LANGUAGE internal IMMUTABLE STRICT;
CREATE FUNCTION vector_out(vector) RETURNS cstring AS 'textout' LANGUAGE internal IMMUTABLE STRICT;
CREATE FUNCTION vector_typmod_in(cstring[]) RETURNS integer AS 'varchartypmodin' LANGUAGE internal IMMUTABLE STRICT;
CREATE FUNCTION vector_typmod_out(integer) RETURNS cstring AS 'varchartypmodout' LANGUAGE internal IMMUTABLE STRICT;
CREATE TYPE vector (INPUT = vector_in, OUTPUT = vector_out, TYPMOD_IN = vector_typmod_in, TYPMOD_OUT = vector_typmod_out,
  INTERNALLENGTH = VARIABLE, STORAGE = extended, ALIGNMENT = int4, CATEGORY = 'U', COLLATABLE = true);
CREATE FUNCTION cosine_distance(a vector, b vector) RETURNS float8 LANGUAGE sql IMMUTABLE STRICT AS $f$
  SELECT 1 - coalesce(sum(x * y) / nullif(sqrt(sum(x * x)) * sqrt(sum(y * y)), 0), 0)
  FROM unnest(string_to_array(trim(both '[]' from a::text), ',')::float8[], string_to_array(trim(both '[]' from b::text), ',')::float8[]) AS t(x, y)
$f$;
CREATE OPERATOR <=> (LEFTARG = vector, RIGHTARG = vector, FUNCTION = cosine_distance);
CREATE FUNCTION vector_cmp(vector, vector) RETURNS integer AS 'bttextcmp' LANGUAGE internal IMMUTABLE STRICT;
CREATE FUNCTION vector_lt(vector, vector) RETURNS boolean AS 'text_lt' LANGUAGE internal IMMUTABLE STRICT;
CREATE FUNCTION vector_le(vector, vector) RETURNS boolean AS 'text_le' LANGUAGE internal IMMUTABLE STRICT;
CREATE FUNCTION vector_eq(vector, vector) RETURNS boolean AS 'texteq' LANGUAGE internal IMMUTABLE STRICT;
CREATE FUNCTION vector_ge(vector, vector) RETURNS boolean AS 'text_ge' LANGUAGE internal IMMUTABLE STRICT;
CREATE FUNCTION vector_gt(vector, vector) RETURNS boolean AS 'text_gt' LANGUAGE internal IMMUTABLE STRICT;
CREATE OPERATOR < (LEFTARG = vector, RIGHTARG = vector, FUNCTION = vector_lt);
CREATE OPERATOR <= (LEFTARG = vector, RIGHTARG = vector, FUNCTION = vector_le);
CREATE OPERATOR = (LEFTARG = vector, RIGHTARG = vector, FUNCTION = vector_eq);
CREATE OPERATOR >= (LEFTARG = vector, RIGHTARG = vector, FUNCTION = vector_ge);
CREATE OPERATOR > (LEFTARG = vector, RIGHTARG = vector, FUNCTION = vector_gt);
CREATE ACCESS METHOD hnsw TYPE INDEX HANDLER bthandler;
CREATE OPERATOR CLASS vector_cosine_ops FOR TYPE vector USING hnsw AS
  OPERATOR 1 <, OPERATOR 2 <=, OPERATOR 3 =, OPERATOR 4 >=, OPERATOR 5 >, FUNCTION 1 vector_cmp(vector, vector);
`;

/** The embedded Postgres package for this platform, next to embedded-postgres in the pnpm store; undefined when not installed. */
function nativeDir(root) {
  const entry = join(root, 'node_modules', 'embedded-postgres');
  if (!existsSync(entry)) return undefined;
  const platform = join(dirname(realpathSync(entry)), '@embedded-postgres', `${process.platform}-${process.arch}`, 'native');
  return existsSync(platform) ? platform : undefined;
}

const native = nativeDir(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
if (native !== undefined) {
  const dir = join(native, 'share', 'postgresql', 'extension');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'vector.control'), CONTROL);
  writeFileSync(join(dir, `vector--${VERSION}.sql`), SCRIPT);
}
