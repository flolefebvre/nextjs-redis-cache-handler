# @flefebvre/nextjs-redis-cache-handler

A Redis/Valkey-backed cache handler for Next.js Cache Components (`'use cache'`), so that every instance of a
multi-instance deployment shares the same cached output and sees the same revalidation events. This package is
under construction: the Zero-config entry and the factory work, but there is no end-to-end coverage yet.
