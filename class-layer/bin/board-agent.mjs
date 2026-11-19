#!/usr/bin/env node
/**
 * board-agent — the estate agent's entry point to the class layer.
 * Implementation: ../src/agent.ts (TypeScript, run on Node's type
 * stripping; erasable syntax only). Data dir: $BOARD_ESTATE_DIR or
 * ~/workspace/board-estate.
 */
import { main } from '../src/agent.ts'

process.exitCode = await main(process.argv.slice(2))
