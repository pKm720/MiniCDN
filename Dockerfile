FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy application source code
COPY . .

# Default port exposure
EXPOSE 3000 3001 3002 3003 4000

# Default command (overridden by docker-compose)
CMD ["npm", "run", "start:lb"]
