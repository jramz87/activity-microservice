// server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json());

// simple rate limiting - just track requests per IP
const requestCounts = new Map();
const DAILY_LIMIT = 60;

function checkRateLimit(req, res, next) {
    const ip = req.ip;
    const today = new Date().toDateString();
    const key = `${ip}-${today}`;
    
    const count = requestCounts.get(key) || 0;
    if (count >= DAILY_LIMIT) {
        return res.status(429).json({ error: 'Daily limit reached - try again tomorrow' });
    }
    
    requestCounts.set(key, count + 1);
    next();
}

// clean up old entries once a day
setInterval(() => {
    const today = new Date().toDateString();
    for (let [key] of requestCounts) {
        if (!key.includes(today)) {
            requestCounts.delete(key);
        }
    }
}, 24 * 60 * 60 * 1000);

// build prompt for GenAI
function buildPrompt(destination, timeOfYear, clientPreferences = {}) {
    let prompt = `You are a travel expert. Give me detailed activity recommendations for ${destination}.`;
    
    if (timeOfYear) {
        prompt += ` The visit is planned for ${timeOfYear}.`;
    }
    
    if (clientPreferences.budget) {
        const budgetText = {
            low: 'budget-friendly',
            medium: 'moderately priced', 
            high: 'premium'
        };
        prompt += ` Focus on ${budgetText[clientPreferences.budget]} activities.`;
    }
    
    if (clientPreferences.interests && clientPreferences.interests.length > 0) {
        prompt += ` The traveler is interested in: ${clientPreferences.interests.join(', ')}.`;
    }
    
    if (clientPreferences.groupSize) {
        prompt += ` This is for a group of ${clientPreferences.groupSize} people.`;
    }
    
    prompt += `\n\nPlease provide:
1. Top 10 specific activities with brief descriptions
2. Local tips and insights
3. Practical information (costs, timing, how to book)
4. Hidden gems locals recommend

Format your response clearly with sections and bullet points.`;
    
    return prompt;
}

// call OpenAI API
async function getRecommendations(prompt) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OpenAI API key not configured');
    }
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: 'You are a professional travel advisor with extensive knowledge of destinations worldwide.'
                },
                {
                    role: 'user', 
                    content: prompt
                }
            ],
            max_tokens: 2000,
            temperature: 0.7
        })
    });
    
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'OpenAI API error');
    }
    
    const data = await response.json();
    return data.choices[0].message.content;
}

// extract bullet points from AI response
function parseResponse(rawResponse) {
    const lines = rawResponse.split('\n');
    const tips = [];
    
    for (let line of lines) {
        line = line.trim();
        // look for bullet points or numbered items
        if (line.match(/^[-•*]\s+/) || line.match(/^\d+\.\s+/)) {
            const tip = line.replace(/^[-•*]\s+/, '').replace(/^\d+\.\s+/, '');
            if (tip.length > 10) {
                tips.push(tip);
            }
        }
    }
    
    return tips.slice(0, 10); // limit to top 10
}

// weather-based activity recommendations
function getWeatherRecommendations(weatherData) {
    const { temp, conditions, windspeed, uvindex } = weatherData;
    
    const lowerConditions = conditions?.toLowerCase() || '';
    
    const isBadWeather = lowerConditions.includes('rain') || 
                        lowerConditions.includes('storm') || 
                        lowerConditions.includes('snow');
    
    const isVeryWindy = windspeed > 25;
    const isVeryHot = temp > 95;
    const isVeryCold = temp < 25;
    const isHighUV = uvindex > 8;

    if (isBadWeather) {
        return {
            recommendation: 'stay-indoors',
            message: 'Stay indoors',
            reason: 'Poor weather conditions',
            color: '#F57C00'
        };
    }

    if (isVeryWindy) {
        return {
            recommendation: 'stay-indoors',
            message: 'Stay indoors', 
            reason: 'Very windy',
            color: '#F57C00'
        };
    }

    if (isVeryHot) {
        return {
            recommendation: 'limited-outdoor',
            message: 'Limited outdoor time',
            reason: 'Extreme heat - stay hydrated',
            color: '#FF5722'
        };
    }

    if (isVeryCold) {
        return {
            recommendation: 'limited-outdoor',
            message: 'Limited outdoor time',
            reason: 'Extreme cold - dress warmly',
            color: '#2196F3'
        };
    }

    if (temp >= 70 && temp <= 85 && !isHighUV) {
        return {
            recommendation: 'perfect-outdoor',
            message: 'Perfect for outdoor activities',
            reason: 'Ideal conditions',
            color: '#4CAF50'
        };
    }

    if (temp >= 60 && temp <= 90) {
        return {
            recommendation: 'good-outdoor',
            message: 'Great for outdoor activities',
            reason: isHighUV ? 'Good weather - use sun protection' : 'Good conditions',
            color: '#4CAF50'
        };
    }

    return {
        recommendation: 'moderate-outdoor',
        message: 'Moderate outdoor conditions',
        reason: 'Fair weather',
        color: '#FF9800'
    };
}

// temperature conversion utilities
function convertTemperature(tempF, unit) {
    if (unit === 'C') {
        return Math.round((tempF - 32) * 5/9);
    }
    return Math.round(tempF);
}

function getTemperatureDisplay(temp, unit) {
    const convertedTemp = convertTemperature(temp, unit);
    return `${convertedTemp}°${unit}`;
}

// weather recommendations endpoint
app.post('/api/weather-recommendations', (req, res) => {
    try {
        const { weatherData } = req.body;
        
        if (!weatherData) {
            return res.status(400).json({ error: 'Weather data is required' });
        }
        
        const recommendations = getWeatherRecommendations(weatherData);
        
        res.json({
            success: true,
            data: recommendations
        });
        
    } catch (error) {
        console.error('Weather recommendations error:', error);
        res.status(500).json({ 
            error: 'Failed to get weather recommendations',
            message: error.message 
        });
    }
});

// temperature conversion endpoint
app.post('/api/convert-temperature', (req, res) => {
    try {
        const { temp, unit } = req.body;
        
        if (temp === undefined || !unit) {
            return res.status(400).json({ error: 'Temperature and unit are required' });
        }
        
        const convertedTemp = convertTemperature(temp, unit);
        const display = getTemperatureDisplay(temp, unit);
        
        res.json({
            success: true,
            data: {
                original: temp,
                converted: convertedTemp,
                display: display,
                unit: unit
            }
        });
        
    } catch (error) {
        console.error('Temperature conversion error:', error);
        res.status(500).json({ 
            error: 'Failed to convert temperature',
            message: error.message 
        });
    }
});

// main endpoint - keeps your existing API working
app.post('/api/explore-destination', checkRateLimit, async (req, res) => {
    try {
        const { destination, timeOfYear, clientPreferences } = req.body;
        
        if (!destination) {
            return res.status(400).json({ error: 'Destination is required' });
        }
        
        console.log(`Getting recommendations for ${destination}`);
        
        // build the prompt
        const prompt = buildPrompt(destination, timeOfYear, clientPreferences);
        
        // get AI response
        const rawResponse = await getRecommendations(prompt);
        
        // parse into structured format
        const generalTips = parseResponse(rawResponse);
        
        // make sure we have enough recommendations
        if (generalTips.length < 5) {
            generalTips.push(
                'Visit the main tourist information center',
                'Ask your hotel concierge for local recommendations', 
                'Check local event calendars for festivals',
                'Try local restaurants recommended by residents',
                'Explore nearby neighborhoods on foot'
            );
        }
        
        const result = {
            recommendations: {
                generalTips: generalTips
            },
            rawResponse: rawResponse
        };
        
        res.json({ 
            success: true,
            data: result 
        });
        
    } catch (error) {
        console.error('Error:', error);
        
        if (error.message.includes('API key')) {
            return res.status(500).json({ error: 'Service configuration error' });
        }
        
        res.status(500).json({ 
            error: 'Failed to get recommendations',
            message: error.message 
        });
    }
});

// health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'activity-recommendations' });
});

app.listen(PORT, () => {
    console.log(`Activity service running on http://localhost:${PORT}`);
});