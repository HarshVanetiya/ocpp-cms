# TypeScript, only the parts you need

Written for someone who has never used TypeScript. It covers exactly what this
project uses and stops. About two hours, and you will not need anything else.

If you already write TypeScript, skip to
[§9](#9-the-five-things-this-project-actually-relies-on) — it names the handful
of features the codebase leans on, which is worth two minutes.

---

## 1. What TypeScript is

JavaScript with type annotations. That is genuinely it.

```ts
// JavaScript
function energyDelivered(meterStart, meterStop) {
  return meterStop - meterStart;
}

// TypeScript — same code, plus a note about what goes in and out
function energyDelivered(meterStart: number, meterStop: number): number {
  return meterStop - meterStart;
}
```

The annotations are **erased before the code runs**. Node never sees them. They
exist so the compiler can tell you, before you run anything:

```ts
energyDelivered("4823110", 4831530);
//              ~~~~~~~~~
// Argument of type 'string' is not assignable to parameter of type 'number'.
```

That example is not academic. OCPP sends meter values **as strings**, so this
exact mistake is one you would otherwise make on day one and discover a week
later in a wrong invoice.

### Why it is worth it here

A CPMS is a machine for turning messages into money. Most of its bugs are shape
bugs: a field that is sometimes missing, a number that is sometimes a string, a
status you forgot to handle. Those are precisely the bugs a type checker
catches for free.

---

## 2. Running it

```bash
mkdir ocpp-cms-server && cd ocpp-cms-server
npm init -y
npm install -D typescript tsx @types/node
npx tsc --init
```

- **`typescript`** — the compiler, `tsc`. Use it to *check* your code.
- **`tsx`** — runs a `.ts` file directly, no build step. Use it to *run* your code.
- **`@types/node`** — type definitions for Node's built-ins.

```bash
npx tsx src/index.ts     # run it
npx tsc --noEmit         # check it, produce nothing
```

`--noEmit` is the one you want in development: it type-checks without writing
JavaScript files you do not need, because `tsx` runs the TypeScript directly.

### The config that matters

`tsconfig.json`, trimmed to the settings that change your life:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

**`"strict": true` is not optional.** Without it, TypeScript allows `undefined`
anywhere and you get the type annotations without most of the safety. Turn it on
now, while the codebase is empty.

**`noUncheckedIndexedAccess`** makes `array[0]` have type `T | undefined`,
because arrays can be empty. Slightly annoying; catches a genuine class of
crash.

---

## 3. The types you will use

### The basics

```ts
const identity: string = 'CP-AMS-0001';
const connectorId: number = 1;
const isCharging: boolean = true;
const stopReason: null = null;
const tariffId: undefined = undefined;
```

You rarely write these, because TypeScript infers them:

```ts
const identity = 'CP-AMS-0001';   // inferred as string
```

**Annotate function parameters and return types; let everything else infer.**
That is the rule this codebase follows.

### Arrays

```ts
const connectorIds: number[] = [1, 2];
const stations: Array<string> = ['CP-001'];   // identical, different spelling
```

### Objects

```ts
const station: { identity: string; connectorCount: number } = {
  identity: 'CP-AMS-0001',
  connectorCount: 2,
};
```

Writing that shape inline every time is miserable, so name it:

```ts
type Station = {
  identity: string;
  connectorCount: number;
};

const station: Station = { identity: 'CP-AMS-0001', connectorCount: 2 };
```

`interface` does almost the same job:

```ts
interface Station {
  identity: string;
  connectorCount: number;
}
```

> **`type` or `interface`?** For a project like this: use `type`. It does
> everything `interface` does plus unions, and one consistent choice beats a
> rule about when to use which.

### Optional and nullable

Three different things, and mixing them up is the most common source of runtime
crashes.

```ts
type Session = {
  transactionId: string;          // always present, never null
  stopReason?: string;            // may be ABSENT from the object
  endedAt: string | null;         // always present, may be null
};
```

```ts
session.stopReason   // string | undefined  — key might not exist
session.endedAt      // string | null       — key exists, value might be null
```

Why the distinction matters here: `endedAt: null` means *"this session has not
ended yet"* — a fact. `stopReason` being absent means *"the station did not
tell us"* — a different fact. Modelling both as optional throws information
away.

### Unions — the most useful feature in the language

```ts
type ConnectorStatus = 'available' | 'charging' | 'faulted' | 'unavailable';

let status: ConnectorStatus = 'charging';   // fine
status = 'Charging';                        // Error: not assignable
```

Those are **literal types**: the value must be exactly one of those four
strings. Typos become compile errors.

And you get exhaustiveness:

```ts
function label(status: ConnectorStatus): string {
  switch (status) {
    case 'available':   return 'Available';
    case 'charging':    return 'Charging';
    case 'faulted':     return 'Faulted';
    case 'unavailable': return 'Out of service';
  }
  // No `default` needed — TypeScript knows every case is covered.
}
```

Add a fifth status to the union and this function stops compiling until you
handle it. For a protocol with nine connector states and twenty stop reasons,
that property is worth a great deal.

### Discriminated unions — how you model OCPP frames

This is the pattern the whole protocol layer is built on.

```ts
type OcppFrame =
  | { type: 'call';       messageId: string; action: string; payload: unknown }
  | { type: 'callresult'; messageId: string; payload: unknown }
  | { type: 'callerror';  messageId: string; code: string; description: string };

function handle(frame: OcppFrame) {
  switch (frame.type) {
    case 'call':
      console.log(frame.action);       // ✓ TypeScript knows `action` exists here
      break;
    case 'callresult':
      console.log(frame.action);       // ✗ Error — a result has no action
      break;
    case 'callerror':
      console.log(frame.code);         // ✓
      break;
  }
}
```

The `type` field is the **discriminant**. Switch on it and TypeScript narrows
the object to exactly the right shape in each branch. No casts, no guessing.

### `unknown` and `any`

```ts
const payload: any = JSON.parse(raw);
payload.anything.at.all.goes;     // compiles. crashes at runtime.

const payload: unknown = JSON.parse(raw);
payload.connectorId;              // Error — you must check first
```

**`any` switches the checker off. `unknown` forces you to check.**

Anything arriving from outside your program — a WebSocket frame, an HTTP body,
a database row — should be `unknown` until you have validated it. That is
exactly what §8 is about.

---

## 4. Async, and why a CPMS is full of it

Nearly everything in a CSMS waits: for a database, for a socket, for a station
to answer.

```ts
async function findStation(identity: string): Promise<Station | null> {
  const rows = await db.query('SELECT * FROM stations WHERE identity = $1', [identity]);
  return rows[0] ?? null;
}

// calling it
const station = await findStation('CP-AMS-0001');
```

- `async` marks a function as returning a `Promise`.
- `await` pauses until the promise settles.
- The return type is `Promise<Station | null>` — `Promise<T>` wraps whatever
  the function actually returns.

### Errors

```ts
try {
  const station = await findStation(identity);
} catch (error) {
  // `error` is `unknown` under strict mode — because anyone can `throw` anything
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ message }, 'lookup failed');
}
```

### The trap that will bite you

```ts
// WRONG — the loop does not wait
stations.forEach(async (s) => {
  await sendCommand(s);
});
console.log('all sent');   // prints immediately; nothing has been sent

// RIGHT — sequential
for (const s of stations) {
  await sendCommand(s);
}

// RIGHT — parallel
await Promise.all(stations.map((s) => sendCommand(s)));
```

`forEach` ignores the promise your callback returns. Use `for…of` when order
matters, `Promise.all` when it does not.

---

## 5. Modules

```ts
// src/ocpp/framing.ts
export type MessageTypeId = 2 | 3 | 4;

export function parseFrame(raw: string): OcppFrame {
  /* … */
}

// default exports exist, but this project does not use them —
// named exports rename consistently and autocomplete better
```

```ts
// src/gateway.ts
import { parseFrame, type MessageTypeId } from './ocpp/framing.js';
```

> **Why `.js` when the file is `.ts`?** Under `"module": "NodeNext"`, you write
> the extension of the file that will *exist at runtime*. Your `.ts` compiles
> to `.js`, so you import `.js`. It looks wrong and it is correct.
>
> The alternative — used in this repo's frontend — is `"moduleResolution":
> "bundler"`, which lets you omit the extension entirely. Bundlers support it;
> plain Node does not. Pick one per project and be consistent.

`import { type MessageTypeId }` marks an import as types-only, so it is erased
completely. Useful when a file exports both.

---

## 6. Generics, briefly

A generic is a type with a hole in it.

```ts
type Paginated<T> = {
  data: T[];
  meta: { page: number; total: number };
};

type StationList = Paginated<Station>;   // data is Station[]
type SessionList = Paginated<Session>;   // data is Session[]
```

You will write your own rarely. You will *use* them constantly — `Promise<T>`,
`Array<T>`, `Map<K, V>` are all generics.

The one place this project asks you to write one:

```ts
function ok<T>(data: T) {
  return { data };
}

ok(station);   // returns { data: Station } — the type follows the input
```

---

## 7. Utility types worth knowing

```ts
type Station = { id: string; identity: string; name: string; tariffId: string | null };

Partial<Station>                    // every field optional — for PATCH bodies
Pick<Station, 'id' | 'name'>        // just those two
Omit<Station, 'id'>                 // everything except id — for create bodies
Record<string, number>              // an object with string keys, number values
Readonly<Station>                   // nothing can be reassigned
```

`Omit` and `Partial` are the two you will reach for:

```ts
type CreateStation = Omit<Station, 'id' | 'createdAt'>;
type UpdateStation = Partial<CreateStation>;
```

---

## 8. Zod — where TypeScript stops and validation starts

**TypeScript types do not exist at runtime.** This compiles and crashes:

```ts
const body = await request.json() as CreateStation;
// `as` is a promise you make to the compiler. Nobody checks it.
// If the body is `{}`, `body.identity` is undefined and you find out later.
```

Zod closes that gap: define the shape **once**, get both a runtime validator
and a TypeScript type.

```ts
import { z } from 'zod';

const CreateStationSchema = z.object({
  identity: z.string().min(1).max(48),
  name: z.string().min(1),
  protocol: z.enum(['ocpp1.6', 'ocpp2.0.1']),
  maxPowerKw: z.number().positive().default(22),
});

// The type, derived from the schema — they can never disagree
type CreateStation = z.infer<typeof CreateStationSchema>;
```

```ts
const result = CreateStationSchema.safeParse(await request.json());

if (!result.success) {
  return reply.status(400).send({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'Check the highlighted fields',
      details: result.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    },
  });
}

const input = result.data;   // typed as CreateStation, and actually verified
```

> `safeParse` returns a result object. `parse` throws. Use `safeParse` at every
> boundary so you control the error response.

**This project hands you every schema already written.**
[`packages/contracts`](../packages/contracts/src) defines all 90 endpoints. Your
backend imports them and validates against the same definitions the frontend
checks responses against — which is why a mismatch shows you the exact field
instead of a blank screen.

---

## 9. The five things this project actually relies on

If you remember nothing else:

1. **Literal union types** for every protocol enum. Nine connector statuses,
   twenty stop reasons — the compiler enforces that you handle all of them.
2. **Discriminated unions** for OCPP frames and realtime events. Switch on
   `type`, get the right shape, no casts.
3. **`unknown` at every boundary**, then Zod. Never `as`.
4. **`z.infer`** so types come from schemas. One definition, not two that drift.
5. **`strict: true`**. Everything above depends on it.

---

## 10. When you get stuck

**"Object is possibly 'undefined'"** — TypeScript is right. Handle the case:

```ts
const first = stations[0];
if (!first) return;
// `first` is Station from here on
```

**"Type 'string' is not assignable to type 'ConnectorStatus'"** — you have a
raw string where a union is wanted. Validate rather than cast:

```ts
const parsed = ConnectorStatusSchema.safeParse(raw);
if (!parsed.success) throw new Error(`Unknown status: ${raw}`);
```

**A wall of red in an editor** — read the **last** line of the error first. The
rest is TypeScript showing its working.

**You genuinely need an escape hatch** — use one, and leave a comment saying
why:

```ts
// The vendor sends a non-standard field here; the OCPP schema has no slot
// for it and we only log it.
const vendorExtra = (payload as Record<string, unknown>).vendorField;
```

An occasional deliberate cast is fine. `any` sprinkled everywhere is not.

---

Next: **[Milestone 0 — setting up →](03-build-the-backend/README.md)**
