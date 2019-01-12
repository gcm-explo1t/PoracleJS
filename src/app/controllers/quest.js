const Controller = require('./controller')
const config = require('config')
const log = require('../logger')
const mustache = require('mustache')

const monsterData = require(config.locale.monstersJson)
const typeData = require('../util/types')
const _ = require('lodash')
const geoTz = require('geo-tz')
const moment = require('moment-timezone')
require('moment-precise-range-plugin')

class Quest extends Controller {

/*
* monsterWhoCares, takes data object
*/
	async questWhoCares(data) {
		return new Promise((resolve) => {
			let areastring = `humans.area like '%${data.matched[0] || 'doesntexist'}%' `
			data.matched.forEach((area) => {
				areastring = areastring.concat(`or humans.area like '%${area}%' `)
			})
			const query = `
			select humans.id, humans.name, quest.template from quest
            join humans on humans.id = quest.id
            where humans.enabled = 1 and
            ((reward in (${data.rewardData.monsters}) and reward_type=7 ) or (reward_type = 2 and reward in (${data.rewardData.items})) or (reward_type = 3 and reward <= ${data.dustAmount})) 
            and
            (round( 6371000 * acos( cos( radians(${data.latitude}) )
              * cos( radians( humans.latitude ) )
              * cos( radians( humans.longitude ) - radians(${data.longitude}) )
              + sin( radians(${data.latitude}) )
              * sin( radians( humans.latitude ) ) ) < quest.distance and quest.distance != 0) or
               quest.distance = 0 and (${areastring}))
			group by humans.id, humans.name, quest.template`


			log.debug(`Query constructed for questWhoCares: \n ${query}`)
			this.db.query(query)
				.then((result) => {
					log.info(`Quest ${data.questType} reported and ${result[0].length} humans cared`)
					resolve(result[0])
				})
				.catch((err) => {
					log.error(`questWhoCares errored with: ${err}`)
				})
		})
	}

	async handle(data) {
		return new Promise((resolve) => {
			switch (config.geocoding.staticProvider.toLowerCase()) {
				case 'google': {
					data.staticmap = `https://maps.googleapis.com/maps/api/staticmap?center=${data.latitude},${data.longitude}&markers=color:red|${data.latitude},${data.longitude}&maptype=${config.geocoding.type}&zoom=${config.geocoding.zoom}&size=${config.geocoding.width}x${config.geocoding.height}&key=${_.sample(config.geocoding.staticKey)}`
					break
				}
				case 'osm': {
					data.staticmap = `https://www.mapquestapi.com/staticmap/v5/map?locations=${data.latitude},${data.longitude}&size=${config.geocoding.width},${config.geocoding.height}&defaultMarker=marker-md-3B5998-22407F&zoom=${config.geocoding.zoom}&key=${_.sample(config.geocoding.staticKey)}`
					break
				}
				case 'mapbox': {
					data.staticmap = `https://api.mapbox.com/styles/v1/mapbox/streets-v10/static/url-https%3A%2F%2Fi.imgur.com%2FMK4NUzI.png(${data.longitude},${data.latitude})/${data.longitude},${data.latitude},${config.geocoding.zoom},0,0/${config.geocoding.width}x${config.geocoding.height}?access_token=${_.sample(config.geocoding.staticKey)}`
					break
				}
				default: {
					data.staticmap = ''
				}
			}
			data.end = Math.trunc(moment(new Date()).tz(geoTz(data.latitude, data.longitude).toString()).endOf('day').valueOf()/1000)

			this.insertOrUpdateQuery(
				'`activeQuest`',
				['pokestop_id', 'pokestop_name', 'type', 'target', 'rewards', 'conditions', 'pokestop_url', 'created_timestamp', 'end_timestamp', 'latitude', 'longitude'],
				[`'${data.pokestop_id}'`, `'${data.name}'`, `${data.type}`, `${data.target}`, `'${JSON.stringify(data.rewards)}'`,  `'${JSON.stringify(data.conditions)}'`,`'${data.pokestop_url}'`,   'UTC_TIMESTAMP()', `FROM_UNIXTIME(${data.end})`, `${data.latitude}`, `${data.longitude}`]
			).catch((err) => {
				log.error(`Updating activeQuest table errored with: ${err}`)
			})

			Promise.all([
				this.getQuestTypeString(data),
				this.getRewardSting(data),
				this.getConditionString(data),
				this.pointInArea([data.latitude, data.longitude])
			]).then((questData) => {
				[data.questType, data.rewardData, data.conditionstring, data.matched] = questData
				data.dustAmount = data.rewardData.dustAmount

				const jobs = []
				const monsternames = []
				const itemnames = []
				data.rewardData.monsters.forEach((m) => {
					if (m) monsternames.push(monsterData[m].name)
				})
				data.rewardData.items.forEach((i) => {
					if (i) itemnames.push(this.qdts.rewardItems[i])
				})
				data.imgurl = data.rewardData.monsters[1] ?
					`${config.general.imgurl}pokemon_icon_${data.rewardData.monsters[1].toString().padStart(3, '0')}_00.png`
					: 'saflkansd'
				if (data.rewardData.items[1]) {
					data.imgurl = `${config.general.imgurl}rewards/reward_${data.rewardData.items[1]}_1.png`
				}
				if (data.dustAmount) {
					data.imgurl = `${config.general.imgurl}rewards/reward_stardust.png`
					data.dustAmount = data.rewards[0].info.amount
				}

				this.questWhoCares(data).then((whoCares) => {
					if (!whoCares[0]) {
						resolve([])
						return null
					}
					let discordCacheBad = true // assume the worst
					whoCares.forEach((cares) => {
						const ch = this.getDiscordCache(cares.id)
						if (ch <= config.discord.limitamount + 1) discordCacheBad = false // but if anyone cares and has not exceeded cache, go on
					})
					if (discordCacheBad) {
						resolve([])
						return null
					}
					this.getAddress({ lat: data.latitude, lon: data.longitude }).then((geoResult) => {
						const view = {
							questType: data.questType,
							reward: data.rewardData.rewardstring.replace(/\n/g, ' '),
							conditions: data.conditionstring.replace(/\n/g, ' '),
							monsterNames: monsternames.join(', '),
							itemNames: itemnames.join(', '),
							stardust: data.type === 3 ? 'stardust' : '',
							imgurl: data.imgurl.toLowerCase(),
							name: data.pokestop_name.replace(/\n/g, ' '),
							url: data.pokestop_url,
							minCp: data.rewardData.monsters[1] ? this.getCp(data.rewardData.monsters[1], 15, 10, 10, 10) : '',
							maxCp: data.rewardData.monsters[1] ? this.getCp(data.rewardData.monsters[1], 15, 15, 15, 15) : '',
							mapurl: `https://www.google.com/maps/search/?api=1&query=${data.latitude},${data.longitude}`,
							applemap: `https://maps.apple.com/maps?daddr=${data.latitude},${data.longitude}`,
							staticmap: data.staticmap,
							// geocode stuff
							lat: data.latitude.toString().substring(0, 8),
							lon: data.longitude.toString().substring(0, 8),
							addr: geoResult.addr,
							streetNumber: geoResult.streetNumber,
							streetName: geoResult.streetName,
							zipcode: geoResult.zipcode,
							country: geoResult.country,
							countryCode: geoResult.countryCode,
							city: geoResult.city,
							state: geoResult.state,
							stateCode: geoResult.stateCode,
							neighbourhood: geoResult.neighbourhood,
							flagemoji: geoResult.flag
						}

						whoCares.forEach((cares) => {
							const caresCache = this.getDiscordCache(cares.id)
							const template = JSON.stringify(this.mdts.quest[cares.template])
							const message = mustache.render(template, view)
							const work = {
								message: caresCache === config.discord.limitamount + 1 ? `You have reached the limit of ${config.discord.limitamount} messages over ${config.discord.limitsec} seconds` : JSON.parse(message),
								target: cares.id,
								name: cares.name,
								emoji: []
							}
							if (caresCache <= config.discord.limitamount + 1) {
								jobs.push(work)
								this.addDiscordCache(cares.id)
							}
						})
						resolve(jobs)
					})
				})
			})
		})
	}

	async getQuestTypeString(data) {
		return new Promise((resolve) => {
			const template = this.qdts.questTypes[data.type]
			const quest = mustache.render(template, { amount: data.target })
			resolve(quest)
		})
	}

	async getRewardSting(data) {
		return new Promise((resolve) => {

			const monsters = [0]
			const items = [0]
			let rewardString = ''
			let dustAmount = 0


			data.rewards.forEach(async (reward) => {
				if (reward.type === 2) {
					const template = this.qdts.questRewardTypes['2']
					const rew = mustache.render(template, { amount: reward.info.amount, item: this.qdts.rewardItems[reward.info.item_id] })
					items.push(reward.info.item_id)
					rewardString = rewardString.concat(rew)
				}
				else if (reward.type === 3) {
					const template = this.qdts.questRewardTypes['3']
					const rew = mustache.render(template, { amount: reward.info.amount })
					dustAmount = reward.info.amount
					rewardString = rewardString.concat(rew)

				}
				else if (reward.type === 7) {
					const template = this.qdts.questRewardTypes['7']
					let e = []
					monsterData[reward.info.pokemon_id].types.forEach((type) => {
						e.push(typeData[type].emoji)
					})
					e = e.join()
					const rew = mustache.render(template, { pokemon: monsterData[reward.info.pokemon_id].name, emoji: e })
					monsters.push(reward.info.pokemon_id)
					rewardString = rewardString.concat(rew)
				}
			})
			resolve({
				rewardstring: rewardString, monsters: monsters, items: items, dustAmount: dustAmount
			})
		})
	}


	async getConditionString(data) {
		return new Promise((resolve) => {
			let conditionString = ''
			data.conditions.forEach((condition) => {
				switch (condition.type) {
					case 1: {
						let typestring = ''
						condition.info.pokemon_type_ids.forEach((typeId) => {
							const typename = _.findKey(typeData, o => o.id === typeId)
							const template = this.qdts.questMonsterTypeString
							const monsterType = mustache.render(template, { name: typename, emoji: typeData[typename].emoji })
							typestring = typestring.concat(monsterType)
						})
						const template = this.qdts.questConditions['1']
						const cond = mustache.render(template, { types: typestring })
						conditionString = conditionString.concat(cond)
						break
					}
					case 2: {
						const pokemons = []
						condition.info.pokemon_ids.forEach((pokemonId) => {
							pokemons.push(monsterData[pokemonId].name)
						})
						const template = this.qdts.questConditions['2']
						const cond = mustache.render(template, { monsters: pokemons.join(', ') })
						conditionString = conditionString.concat(cond)
						break
					}
					case 3: {
						const cond = this.qdts.questConditions['3']
						conditionString = conditionString.concat(cond)
						break
					}
					case 6: {
						const cond = this.qdts.questConditions['6']
						conditionString = conditionString.concat(cond)
						break
					}
					case 7: {
						const template = this.qdts.questConditions['7']
						const cond = mustache.render(template, { levels: condition.info.raid_levels.join(', ') })
						conditionString = conditionString.concat(cond)
						break
					}
					case 8: {
						const template = this.qdts.questConditions['8']
						const cond = mustache.render(template, { throw_type: this.qdts.throwType[condition.info.throw_type_id] })
						conditionString = conditionString.concat(cond)
						break
					}
					case 9: {
						const cond = this.qdts.questConditions['9']
						conditionString = conditionString.concat(cond)
						break
					}
					case 10: {
						const cond = this.qdts.questConditions['10']
						conditionString = conditionString.concat(cond)
						break
					}
					case 11: {
						const template = this.qdts.questConditions['11']
						const item = condition.info ? this.qdts.rewardItems[condition.info.item_id] : ''
						const cond = mustache.render(template, { item: item })
						conditionString = conditionString.concat(cond)
						break
					}
					case 14: {
						const template = this.qdts.questConditions['14']
						const cond = mustache.render(template, { throw_type: this.qdts.throwType[condition.info.throw_type_id], amount: data.target })
						conditionString = conditionString.concat(cond)
						break
					}
					case 15: {
						const cond = this.qdts.questConditions['15']
						conditionString = conditionString.concat(cond)
						break
					}
					default:
				}
			})
			resolve(conditionString)
		})
	}

}

module.exports = Quest