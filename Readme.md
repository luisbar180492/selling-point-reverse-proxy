## How to install?

1. Clone the repo
```bash
git clone --recursive git@personal-gitlab:luisbar/selling-point-reverse-proxy.git
```

2. Create keys for the JWT into `selling-point-auth/src` folder using the instructions in the `selling-point-auth/Readme.md` file

3. Create an empty `.env` file on `selling-point-admin-dashboard`

4. Create an `.env` file on `selling-point-reverse-proxy` using the `.env.example` file as a template

5. Run using docker compose
```bash
docker compose build
docker-compose up
```

## How to update submodules?

1. Execute the following command
```bash
git submodule update --recursive --remote
```