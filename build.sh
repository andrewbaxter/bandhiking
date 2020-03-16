#!/usr/bin/bash
go build -o bin/app
rm -rf static
cp -r prestatic static
(
	cd ts
	npm install
	node_modules/.bin/tsc --build tsconfig.json
	node_modules/.bin/rollup -c
	rm src/*.js
)
