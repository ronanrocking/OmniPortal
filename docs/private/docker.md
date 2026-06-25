# Docker Notes

## Why we are using Docker

For OmniPortal, anything we run on the Raspberry Pi should live in Docker.

That gives us:

- a cleaner Raspberry Pi
- less manual setup on the machine itself
- a more portable project
- an easier path to later move the same app to a VM or server

Important nuance:

Docker makes the application setup much more portable, but it does not make the host machine irrelevant. CPU architecture, OS version, and kernel support still matter.

## What Docker is

Docker packages an application together with the things it needs to run.

Useful mental model:

- `image`: the blueprint
- `container`: a running instance of that blueprint
- `Dockerfile`: the recipe used to build the image
- `docker compose`: the tool that runs multiple containers together as one app

## What Docker Compose is

Docker Compose is how we define a multi-service app in one file.

For OmniPortal, that matters because the project will naturally have multiple parts:

- backend
- frontend
- later possibly Redis, a database, or other supporting services

Instead of remembering long `docker run` commands, we can define services in `docker-compose.yml` and start everything with:

```bash
docker compose up
```

## Questions asked today

### Does the old Raspbian matter if we are using Docker?

Yes, it still matters.

Docker helps a lot with portability, but it does not fully hide:

- host CPU architecture
- host OS age
- kernel capabilities

Today the Pi was:

- `Raspbian GNU/Linux 10 (buster)`
- `armv7l`
- `32-bit`

This is okay for learning and initial testing, but it is older than ideal for long-term scaling.

Future note:

We may later move the Pi to a newer 64-bit OS, but we are not blocking on that right now.

### What is a keyring folder?

A keyring folder is where Linux stores trusted signing keys for package repositories.

In our case:

`/etc/apt/keyrings/`

This is where we stored Docker's repository key so `apt` can verify packages from Docker's repository.

### What is a GPG key?

A GPG key is a trust/signature mechanism.

When a package repository signs its packages, your system can use the GPG key to verify:

- the package really came from that repository
- the package was not tampered with

For Docker, that key lets the Pi trust Docker's official package repository.

### What does `tee` do in the repo command?

`tee` takes text from standard input and writes it to a file.

We used it like this:

```bash
echo "deb [arch=armhf signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/raspbian buster stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

Why:

- `echo` produced the repository line
- `tee` wrote it into a root-owned file
- `sudo` applied to `tee`, so the write had permission

This is safer than trying to rely on shell redirection with `sudo echo`.

## What happened during setup

### 1. We checked the Pi environment

Commands used:

```bash
uname -m
cat /etc/os-release
getconf LONG_BIT
```

We learned:

- architecture: `armv7l`
- OS: `Raspbian GNU/Linux 10 (buster)`
- bitness: `32`

### 2. We hit an `apt` repository problem

The old Raspbian package source was broken and returning `404`.

The file involved was:

`/etc/apt/sources.list`

To get `apt` working again, we temporarily disabled the broken Raspbian repo entry.

That let `apt update` complete successfully.

### 3. We prepared apt for Docker

Installed:

```bash
sudo apt install -y ca-certificates curl gnupg
```

These are needed to safely add Docker's repository key and repository entry.

### 4. We added Docker's signing key

Commands used:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/raspbian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
```

### 5. We added Docker's package repository

Command used:

```bash
echo "deb [arch=armhf signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/raspbian buster stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

Then:

```bash
sudo apt update
```

### 6. We installed Docker

Command used:

```bash
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Installed pieces:

- `docker-ce`: Docker Engine
- `docker-ce-cli`: Docker command-line client
- `containerd.io`: low-level container runtime
- `docker-buildx-plugin`: better image builds
- `docker-compose-plugin`: `docker compose`

### 7. We verified Docker works

The `hello-world` test successfully pulled and ran.

That confirmed:

- Docker is installed
- Docker can pull images
- Docker can start containers

## Where we ended today

Docker is set up on the Raspberry Pi.

We still want one convenience step if it has not already been done:

```bash
sudo usermod -aG docker $USER
```

After that, log out and SSH back in, then test:

```bash
docker ps
docker compose version
```

If those work without `sudo`, the setup is more comfortable for daily use.

## What we should do next

The next project step is not more Docker installation.

It is to start the actual OmniPortal project structure in a Docker-first way:

- `backend/`
- `frontend/`
- `docker-compose.yml`

Then build the smallest possible backend container first.
