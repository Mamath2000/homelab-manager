// hm-sign manages the Ed25519 key that signs the agent binaries of a release.
//
//	hm-sign keygen -key FILE -pub FILE   new key pair (refuses to overwrite an existing key)
//	hm-sign pub -key FILE                print the public key (base64)
//	hm-sign sign -key FILE BINARY...     write BINARY.sig next to each binary
//
// The private key file holds the base64 seed; it stays out of the repository. The public key is
// embedded in the agents (-X main.releasePubKey=…), which refuse an update whose signature does
// not verify. The signed message must match agent/signature.go.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func signedMessage(sha256hex string) []byte {
	return []byte("homelab-agent/v1:" + sha256hex)
}

func loadKey(file string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("%s: not a release key", file)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func pubString(key ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
}

func keygen(keyFile, pubFile string) error {
	if _, err := os.Stat(keyFile); err == nil {
		return fmt.Errorf("%s already exists: keep it (agents trust its public key)", keyFile)
	}
	if _, err := os.Stat(pubFile); err == nil {
		return fmt.Errorf("%s already exists: copy the matching private key to %s, or delete %s to change keys "+
			"(installed agents then refuse updates until upgraded by hand)", pubFile, keyFile, pubFile)
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(keyFile), 0o700); err != nil {
		return err
	}
	seed := base64.StdEncoding.EncodeToString(key.Seed()) + "\n"
	if err := os.WriteFile(keyFile, []byte(seed), 0o600); err != nil {
		return err
	}
	return os.WriteFile(pubFile, []byte(pubString(key)+"\n"), 0o644)
}

func sign(key ed25519.PrivateKey, file string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	sig := ed25519.Sign(key, signedMessage(hex.EncodeToString(h.Sum(nil))))
	return os.WriteFile(file+".sig", []byte(base64.StdEncoding.EncodeToString(sig)+"\n"), 0o644)
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: hm-sign keygen|pub|sign -key FILE …")
	}
	fs := flag.NewFlagSet("hm-sign "+args[0], flag.ContinueOnError)
	keyFile := fs.String("key", "", "private key file")
	pubFile := fs.String("pub", "", "keygen: public key file to write")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *keyFile == "" {
		return errors.New("-key is required")
	}
	switch args[0] {
	case "keygen":
		if *pubFile == "" {
			return errors.New("keygen: -pub is required")
		}
		return keygen(*keyFile, *pubFile)
	case "pub":
		key, err := loadKey(*keyFile)
		if err != nil {
			return err
		}
		fmt.Println(pubString(key))
		return nil
	case "sign":
		key, err := loadKey(*keyFile)
		if err != nil {
			return err
		}
		if fs.NArg() == 0 {
			return errors.New("sign: no file given")
		}
		for _, file := range fs.Args() {
			if err := sign(key, file); err != nil {
				return err
			}
			fmt.Printf("signed %s\n", file)
		}
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "hm-sign:", err)
		os.Exit(1)
	}
}
