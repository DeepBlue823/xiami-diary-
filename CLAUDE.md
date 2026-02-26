# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A diary web application for a girlfriend (小咪) deployed on Vercel with Redis storage. The app has two access levels:
- **index.html** - Public read-only view for 小咪
- **edit.html** - Admin write access with password protection

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (no frameworks)
- **Backend**: Vercel Serverless Functions (Node.js)
- **Database**: Redis (via ioredis)
- **Deployment**: Vercel connected to GitHub

## Key Files

- `index.html` - Public diary viewing page
- `edit.html` - Admin editing page with login
- `api/auth.js` - Login authentication endpoint
- `api/diaries.js` - Diary CRUD API (GET public, POST/DELETE requires auth token)
- `vercel.json` - Vercel configuration with rewrites

## Environment Variables (Vercel)

Required in Project Settings → Environment Variables:
- `REDIS_URL` - Redis connection string
- `ADMIN_PASSWORD` - Password for admin access

## Deployment

Push changes to GitHub main branch, Vercel automatically deploys. After modifying API files, must redeploy.

## Important Notes

- ioredis package is used for Redis connection (not @vercel/kv)
- The API uses ioredis with `import` syntax (ES modules)
- Token-based auth with 7-day expiration stored in Redis
