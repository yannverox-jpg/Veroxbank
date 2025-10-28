#!/usr/bin/env bash
ZIPNAME=lyra_banque_ready.zip
zip -r $ZIPNAME . -x node_modules/* .git/*
echo "Created $ZIPNAME"
